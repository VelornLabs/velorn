// A click on the Sound tab's priced button approves that tab's own cloud requests, and nothing else.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { COMFY_CLOUD, cloudVoiceWorkflow, soniloWorkflow, stableAudioWorkflow } from '../src/services/createFlow.mjs'

const require = createRequire(import.meta.url)
const { soundCloudApproval, BUTTON_APPROVAL_USD } = require('../electron/soundCloudApproval.cjs')
const { registerGenerationSpendingIpc, CHANNELS } = require('../electron/generationSpending.cjs')

const model = id => COMFY_CLOUD.find(item => item.id === id)
const wire = value => JSON.parse(JSON.stringify(value)) // what arrives over IPC
const voiceFlow = (id, text = 'Hello there, this is a test line.') => wire(cloudVoiceWorkflow(model(id), { text, voice: model(id).voices[0].id, seed: 7 }).workflow)
const song = (lyrics = '') => wire(soniloWorkflow({ prompt: 'warm lo-fi piano', seconds: 60, lyrics, seed: 7 }))

test('every cloud request the Sound tab builds is recognised, at no less than the price it shows', () => {
  const text = 'x'.repeat(1000)
  for (const id of ['fish-s2-pro', 'fish-drama-3', 'heygen-tts']) {
    const found = soundCloudApproval(voiceFlow(id, text))
    assert.ok(found, id)
    assert.ok(found.maxUsd >= model(id).usdPer1kCharacters - 1e-9 && found.maxUsd <= BUTTON_APPROVAL_USD, `${id} ${found.maxUsd}`)
  }
  assert.deepEqual(soundCloudApproval(song()), { label: 'Sonilo', maxUsd: 0.15 })
  assert.equal(soundCloudApproval(song('la la la')).maxUsd, 0.1931)
  // The longest and dearest of each still fits under what a click may approve.
  assert.ok(soundCloudApproval(wire(soniloWorkflow({ prompt: 'p', seconds: 360, lyrics: 'la', seed: 1 }))).maxUsd <= BUTTON_APPROVAL_USD)
  assert.ok(soundCloudApproval(voiceFlow('heygen-tts', 'x'.repeat(3000))).maxUsd <= BUTTON_APPROVAL_USD)
  assert.ok(soundCloudApproval(voiceFlow('fish-drama-3', '語'.repeat(3000))).maxUsd <= BUTTON_APPROVAL_USD)
})

test('anything that is not exactly one of those requests is not recognised', () => {
  const change = (flow, edit) => { const copy = wire(flow); edit(copy); return copy }
  const fish = voiceFlow('fish-s2-pro'), heygen = voiceFlow('heygen-tts')
  for (const [why, flow] of [
    ['an extra node', change(fish, f => { f[4] = { class_type: 'SaveAudioMP3', inputs: {} } })],
    ['a second paid node', change(song(), f => { f[3] = f[1] })],
    ['another model', change(fish, f => { f[2].inputs.model = 's9-ultra' })],
    ['an extra input', change(fish, f => { f[2].inputs.extra = 1 })],
    ['too much text', change(fish, f => { f[2].inputs.text = 'x'.repeat(3001) })],
    ['a slowed voice', change(heygen, f => { f[1].inputs.speed = 0.1 })],
    ['a custom voice', change(heygen, f => { f[1].inputs.custom_voice_id = 'abc' })],
    ['too long a song', change(song(), f => { f[1].inputs.duration = 100000 })],
    ['another paid node', { 1: { class_type: 'OpenAIGPTImage1', inputs: { prompt: 'x' } } }],
    ['a local workflow', wire(stableAudioWorkflow({ prompt: 'rain', seconds: 5, seed: 1 }))],
    ['nothing', null], ['a list', []],
  ]) assert.equal(soundCloudApproval(flow), null, why)
})

// The native gate, with a ComfyUI that reports these as paid API nodes.
function gate(policy = 'ask-cloud') {
  const api = name => ({ name, python_module: 'comfy_api_nodes.nodes_audio', api_node: true })
  const objectInfo = { ...Object.fromEntries(['SoniloTextToMusic', 'SoniloMusic15', 'HeyGenTextToSpeechNode', 'FishAudioVoiceSelector', 'FishAudioTextToSpeech', 'OpenAIGPTImage1'].map(name => [name, api(name)])),
    SaveAudioMP3: { name: 'SaveAudioMP3', python_module: 'comfy_extras.nodes_audio' } }
  const contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false, send() {} })
  const window = { webContents: contents, isDestroyed: () => false }
  const handlers = new Map(), asked = [], posts = [], recorded = []
  const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } })
  const controller = registerGenerationSpendingIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) },
    getMainWindow: () => window, readPolicy: () => policy, writePolicy: () => {}, getEndpoint: () => 'http://127.0.0.1:8188',
    getContext: () => ({ session: 's', projectKey: '/p', timelineId: 't' }), getApiKey: async () => 'synthetic-key',
    confirmSpend: async input => { asked.push(input); return false }, assertAvailable: () => {},
    beforeSubmit: request => { recorded.push(request.assessment) },
    fetchImpl: async (url, init) => { if (url.endsWith('/object_info')) return json(objectInfo); posts.push(JSON.parse(init.body)); return json({ prompt_id: 'p1', number: 0, node_errors: {} }) },
  })
  let n = 0
  const send = (name, workflow, ...extra) => handlers.get(CHANNELS[name])({ sender: contents, senderFrame: contents.mainFrame },
    { requestId: `sound-approval-test-${++n}`, endpoint: 'http://127.0.0.1:8188', clientId: 'c', workflow }, ...extra)
  return { send, asked, posts, recorded, controller }
}

test('a priced click sends the Sound tab’s request without the native question, with the account key', async () => {
  const g = gate()
  const result = await g.send('queuePriced', voiceFlow('fish-s2-pro'))
  assert.equal(result.success, true)
  assert.equal(g.asked.length, 0)
  assert.equal(g.posts.length, 1)
  assert.equal(g.posts[0].extra_data.api_key_comfy_org, 'synthetic-key')
  assert.equal(g.recorded[0].buttonApproved, true)
  assert.equal(g.recorded[0].approvedLabel, 'Fish Audio')
  assert.equal((await g.send('queuePriced', song('la la'))).success, true)
  assert.equal(g.asked.length, 0)
})

test('the same request by any other route is still asked about', async () => {
  const g = gate()
  // The ordinary route, an extra argument on it, and the route agents use.
  assert.equal((await g.send('queue', voiceFlow('fish-s2-pro'))).success, false)
  assert.equal((await g.send('queue', voiceFlow('fish-s2-pro'), true)).success, false)
  assert.equal((await g.controller.queueFromMain({ requestId: 'sound-approval-test-main', endpoint: 'http://127.0.0.1:8188', clientId: 'c', workflow: voiceFlow('heygen-tts') })).success, false)
  assert.equal(g.asked.length, 3)
  assert.equal(g.posts.length, 0)
})

test('a priced click does not cover other paid workflows, or Local only', async () => {
  const g = gate()
  assert.equal((await g.send('queuePriced', { 1: { class_type: 'OpenAIGPTImage1', inputs: { prompt: 'x', model: 'gpt-image-1' } } })).success, false)
  const altered = voiceFlow('fish-s2-pro'); altered[2].inputs.text = 'x'.repeat(5000)
  assert.equal((await g.send('queuePriced', altered)).success, false)
  assert.equal(g.asked.length, 2)
  const localOnly = gate('local-only')
  const blocked = await localOnly.send('queuePriced', voiceFlow('fish-s2-pro'))
  assert.equal(blocked.code, 'GENERATION_SPENDING_LOCAL_ONLY')
  assert.equal(g.posts.length + localOnly.posts.length, 0)
})
