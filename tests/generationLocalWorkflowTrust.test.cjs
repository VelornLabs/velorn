'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createLocalWorkflowTrustStore, localTrustCandidate, GENERATION_LOCAL_TRUST_SETTING_KEY } = require('../electron/generationLocalWorkflowTrust.cjs')

const source = () => ({ a: { class_type: 'MiniMaxH3Generate', inputs: { prompt: 'original private prompt', seed: 1,
  model: 'h3.safetensors', image: 'original.png', audio: 'original.wav', endpoint: 'http://127.0.0.1:9123' } },
  b: { class_type: 'SaveVideo', inputs: { video: ['a', 0], filename_prefix: 'private-output' } } })
const metadata = () => ({ MiniMaxH3Generate: { name: 'MiniMaxH3Generate', python_module: 'custom_nodes.minimax_h3', api_node: false },
  SaveVideo: { name: 'SaveVideo', python_module: 'comfy_extras.nodes_video' } })
const options = () => ({ saved: { success: true, ready: true, workflowId: 'my-workflow:synthetic-h3', title: 'Synthetic H3', graphFingerprint: 'a'.repeat(64), workflow: source() },
  workflow: source(), endpoint: 'http://127.0.0.1:8188', objectInfo: metadata() })
const authority = () => ({ signal: new AbortController().signal, isCurrent: () => true })
function fixture() {
  let data = null
  const writes = []
  const api = () => createLocalWorkflowTrustStore({ readStore: async () => structuredClone(data),
    writeStore: async value => { data = structuredClone(value); writes.push(data) }, now: () => 1234 })
  return { api, writes, get data() { return data }, set data(value) { data = value } }
}

test('saved revision plus endpoint, graph and live node identity determine remembered trust', () => {
  const original = options(), first = localTrustCandidate(original)
  assert.equal(first.eligible, true)
  assert.equal(first.reference, first.id.slice(0, 16))
  const creative = options()
  Object.assign(creative.workflow.a.inputs, { prompt: 'another private prompt', seed: 999, image: 'uploaded-new.png', audio: 'uploaded-new.wav' })
  creative.workflow.b.inputs.filename_prefix = 'a-different-output'
  assert.equal(localTrustCandidate(creative).id, first.id)
  assert.equal(localTrustCandidate({ ...original, workflow: { b: original.workflow.b, a: original.workflow.a } }).id, first.id)
  for (const mutate of [
    value => { value.saved.graphFingerprint = 'b'.repeat(64) },
    value => { value.endpoint = 'http://127.0.0.1:8189' },
    value => { value.objectInfo.MiniMaxH3Generate.python_module = 'custom_nodes.replacement' },
    value => { value.objectInfo.MiniMaxH3Generate.api_node = true },
    value => { value.objectInfo.MiniMaxH3Generate.price_badge = {} },
    value => { value.objectInfo = null },
  ]) {
    const changed = options(); mutate(changed)
    assert.notEqual(localTrustCandidate(changed).id, first.id)
  }
})

test('unpersisted or mismatched model/link/endpoint/node graphs cannot borrow a saved workflow title', () => {
  for (const mutate of [
    value => { value.saved = null },
    value => { value.saved.workflowId = '../../arbitrary' },
    value => { value.saved.graphFingerprint = 'guessed' },
    value => { value.workflow.a.inputs.model = 'cloud-model' },
    value => { value.workflow.a.inputs.endpoint = 'https://paid.invalid' },
    value => { value.workflow.b.inputs.video = ['a', 1] },
    value => { value.workflow.a.class_type = 'AnotherGenerator' },
    value => { value.workflow.a.inputs.script = 'network-call' },
  ]) {
    const changed = options(); mutate(changed)
    assert.equal(localTrustCandidate(changed).eligible, false)
  }
})

test('trust persists across store recreation, replaces older revision and revokes without graph data', async () => {
  const f = fixture(), store = f.api(), candidate = localTrustCandidate(options())
  assert.equal(GENERATION_LOCAL_TRUST_SETTING_KEY, 'generationLocalWorkflowTrust')
  assert.equal(await store.has(candidate), false)
  await store.remember(candidate, authority())
  assert.equal(await f.api().has(candidate), true)
  const serialized = JSON.stringify(f.data)
  for (const privateText of ['original private prompt', 'private-output', 'original.png', 'original.wav', 'h3.safetensors', '9123']) assert.equal(serialized.includes(privateText), false)
  assert.equal((await store.list())[0].sourceGraphFingerprint, undefined)
  const changed = options(); changed.saved.graphFingerprint = 'b'.repeat(64)
  const next = localTrustCandidate(changed)
  await store.remember(next, authority())
  assert.equal((await store.list()).length, 1)
  assert.equal(await store.has(candidate), false)
  assert.equal(await store.has(next), true)
  await store.revoke(next.id, authority())
  assert.deepEqual(await store.list(), [])
})

test('writes serialize, corrupt/future stores remain unchanged, and failures are visible', async () => {
  const f = fixture(), store = f.api(), a = localTrustCandidate(options())
  const other = options(); other.saved.workflowId = 'my-workflow:other'
  const b = localTrustCandidate(other)
  await Promise.all([store.remember(a, authority()), store.remember(b, authority())])
  assert.equal((await store.list()).length, 2)
  for (const corrupt of [{ version: 2, entries: [] }, { version: 1, entries: [{}] }, 'corrupt']) {
    f.data = corrupt
    await assert.rejects(store.remember(a, authority()), /could not be read/)
    assert.deepEqual(f.data, corrupt)
  }
  await assert.rejects(createLocalWorkflowTrustStore({ readStore: () => null, writeStore: () => ({ success: false }) }).remember(a, authority()), /could not be saved/)
  await assert.rejects(createLocalWorkflowTrustStore({ readStore: () => null, writeStore: () => undefined }).remember(a, authority()), /could not be saved/)
})

test('only a current native authority can persist trust', async () => {
  const f = fixture(), store = f.api(), candidate = localTrustCandidate(options()), controller = new AbortController()
  controller.abort()
  for (const stale of [undefined, {}, { isCurrent: () => false }, { signal: controller.signal, isCurrent: () => true }]) {
    await assert.rejects(store.remember(candidate, stale), /cancelled/)
  }
  assert.equal(f.writes.length, 0)
})
