import test from 'node:test'
import assert from 'node:assert/strict'
import { AGENT_ENTRY_INTENT_KEY, agentEntryReadiness, createAgentEntryGuide } from '../src/utils/agentEntryGuide.mjs'

function fixture({ values = new Map(), hasPriorIntent = false, storage } = {}) {
  const calls = []
  let selection = { provider: 'codex', endpoint: 'http://127.0.0.1:1234/v1', model: '' }
  const guide = createAgentEntryGuide({ getSelection: () => selection, hasPriorIntent,
    storage: storage || { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) },
    inspect: args => { calls.push(args); throw Error('Entry must never inspect') } })
  return { guide, calls, values, select: patch => { selection = { ...selection, ...patch } } }
}

test('readiness distinguishes Codex setup, sign-in and failures without trusting generic success', () => {
  const codex = { provider: 'codex' }
  assert.equal(agentEntryReadiness({ success: true, available: true }, codex).phase, 'ready')
  assert.equal(agentEntryReadiness({ success: true }, codex).phase, 'problem')
  assert.equal(agentEntryReadiness({ success: false, code: 'CODEX_NOT_FOUND' }, codex).codexState, 'missing')
  for (const code of ['CODEX_LOGIN_REQUIRED', 'CODEX_CHATGPT_REQUIRED']) assert.equal(agentEntryReadiness({ success: false, code }, codex).codexState, 'signin')
  const failed = agentEntryReadiness({ success: false, error: 'PRIVATE raw path' }, codex)
  assert.equal(failed.phase, 'problem'); assert.doesNotMatch(JSON.stringify(failed), /PRIVATE/)
})

test('local readiness preserves explicit model selection and distinguishes available from unloaded', () => {
  const result = { success: true, available: true, loadedModelStatus: 'available', models: [{ id: 'chosen', loaded: true }, { id: 'other', loaded: false }] }
  assert.equal(agentEntryReadiness(result, { provider: 'lmstudio', model: 'chosen' }).phase, 'ready')
  for (const model of ['', 'other', 'missing']) assert.equal(agentEntryReadiness(result, { provider: 'lmstudio', model }).phase, 'unconfigured')
  assert.equal(agentEntryReadiness({ success: false }, { provider: 'lmstudio', model: 'chosen' }).phase, 'problem')
  assert.equal(agentEntryReadiness({ ...result, loadedModelStatus: 'unavailable' }, { provider: 'lmstudio', model: 'other' }).phase, 'ready')
})

test('fresh entry offers a neutral choice without assuming default Codex means intent or probing', () => {
  const f = fixture()
  assert.deepEqual(f.guide.getSnapshot(), { phase: 'choice', dismissed: false })
  f.guide.selectionChanged()
  assert.equal(f.guide.getSnapshot().phase, 'choice'); assert.deepEqual(f.calls, []); assert.equal(f.values.size, 0)
})

test('existing intent stays quiet without declaring a stopped or unchecked provider ready', () => {
  const f = fixture({ hasPriorIntent: true })
  assert.equal(f.guide.getSnapshot().phase, 'idle'); f.guide.selectionChanged()
  assert.equal(f.guide.getSnapshot().phase, 'idle'); assert.deepEqual(f.calls, [])
})

test('Skip is device-local and survives a new panel, project and provider', () => {
  const first = fixture(); first.guide.skip()
  assert.deepEqual(JSON.parse(first.values.get(AGENT_ENTRY_INTENT_KEY)), { acknowledged: true })
  const remount = fixture({ values: first.values }); remount.select({ provider: 'lmstudio' }); remount.guide.selectionChanged()
  assert.equal(remount.guide.getSnapshot().phase, 'idle'); assert.equal(remount.guide.getSnapshot().dismissed, true)
  assert.deepEqual(remount.calls, []); assert.equal(first.values.size, 1)
})

test('explicit later failure can offer help after Skip, but another opening never repeats it', () => {
  const f = fixture(); f.guide.skip(); f.guide.observe({ success: false, code: 'CODEX_NOT_FOUND' })
  assert.equal(f.guide.getSnapshot().phase, 'unconfigured'); assert.equal(f.guide.getSnapshot().dismissed, false)
  const reopened = fixture({ values: f.values })
  assert.equal(reopened.guide.getSnapshot().phase, 'idle'); assert.deepEqual(f.calls, [])
})

test('successful explicit check records intent, never persisted readiness or account details', () => {
  const f = fixture(); f.guide.observe({ success: true, available: true, privatePath: '/PRIVATE', token: 'SECRET' })
  assert.equal(f.guide.getSnapshot().phase, 'ready')
  assert.equal(f.values.get(AGENT_ENTRY_INTENT_KEY), '{"acknowledged":true}')
  assert.equal(fixture({ values: f.values }).guide.getSnapshot().phase, 'idle')
  f.guide.invalidate(); assert.equal(f.guide.getSnapshot().phase, 'idle'); assert.deepEqual(f.calls, [])
})

test('manual selection reclassifies explicit cached metadata, but changed endpoint clears stale result', () => {
  const f = fixture(); f.select({ provider: 'lmstudio' })
  f.guide.observe({ success: true, available: true, loadedModelStatus: 'available', models: [{ id: 'chosen', loaded: true }] })
  assert.equal(f.guide.getSnapshot().phase, 'unconfigured'); f.select({ model: 'chosen' }); f.guide.selectionChanged()
  assert.equal(f.guide.getSnapshot().phase, 'ready')
  f.select({ endpoint: 'http://127.0.0.1:1235/v1' }); f.guide.selectionChanged()
  assert.equal(f.guide.getSnapshot().phase, 'idle'); assert.deepEqual(f.calls, [])
})

test('invalid or unavailable preference storage remains safe and dismissal works in RAM', () => {
  for (const storage of [
    { getItem: () => '{broken', setItem() { throw Error('No storage') } },
    { getItem() { throw Error('No storage') }, setItem() { throw Error('No storage') } },
    { getItem: () => '{"acknowledged":"yes"}', setItem() {} },
  ]) {
    const f = fixture({ storage }); assert.equal(f.guide.getSnapshot().phase, 'choice')
    f.guide.skip(); assert.equal(f.guide.getSnapshot().phase, 'idle'); assert.deepEqual(f.calls, [])
  }
})
