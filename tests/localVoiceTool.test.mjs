import test from 'node:test'
import assert from 'node:assert/strict'
import { planLocalVoice, localVoiceList, LOCAL_VOICE_TEXT_MAX, LOCAL_VOICE_DEFAULT } from '../src/services/localVoiceTool.mjs'
import { LOCAL_VOICE } from '../src/services/createFlow.mjs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

test('the agent may ask the built-in voice only for what the Sound tab offers', () => {
  const plan = planLocalVoice({ text: '  Hello from the beach.  ' })
  assert.deepEqual([plan.text, plan.voice, plan.characters, plan.model], ['Hello from the beach.', LOCAL_VOICE_DEFAULT, 21, 'Kokoro'])
  assert.equal(planLocalVoice({ text: 'Hi', voice: 'bm_george', previewOnly: false }).voiceName, 'George')
  assert.equal(planLocalVoice({ text: 'x'.repeat(LOCAL_VOICE_TEXT_MAX) }).characters, LOCAL_VOICE_TEXT_MAX)
  for (const [payload, wording] of [
    [{}, /words to say/], [{ text: '   ' }, /words to say/], [{ text: 7 }, /words to say/],
    [{ text: 'x'.repeat(LOCAL_VOICE_TEXT_MAX + 1) }, /up to 3000 characters/],
    [{ text: 'Hi', voice: 'rachel' }, /Unknown voice/], [{ text: 'Hi', voice: '../x' }, /Unknown voice/], [{ text: 'Hi', voice: null }, /Unknown voice/],
    [{ text: 'Hi', filePath: '/tmp/x.wav' }, /does not take "filePath"/], [{ text: 'Hi', model: 'other' }, /does not take "model"/],
    [{ text: 'a\u0000b' }, /cannot be spoken/],
  ]) assert.throws(() => planLocalVoice(payload), wording, JSON.stringify(payload))
})

test('the tool, the Sound tab and the native file list name the same voices', () => {
  const voices = localVoiceList().map(voice => voice.id)
  assert.deepEqual(voices, LOCAL_VOICE[0].voices.map(voice => voice.id))
  const { createComfyStudioMcpServer } = require('../electron/mcpServer.js')
  const tool = createComfyStudioMcpServer().tools.find(item => item.name === 'generate_local_voice')
  assert.deepEqual(tool.inputSchema.properties.voice.enum, voices)
  assert.equal(tool.inputSchema.properties.text.maxLength, LOCAL_VOICE_TEXT_MAX)
  assert.deepEqual(tool.inputSchema.required, ['text'])
  assert.match(tool.description, /no cloud credits/)
  assert.match(tool.description, /an agent cannot start that download/)
})

test('the built-in voice is previewed freely, applied only with approval, and its status is a plain read', () => {
  const { READ_TOOLS, SAFE_PREVIEW_TOOLS } = require('../electron/connectedAgentTools.cjs')
  if (READ_TOOLS && SAFE_PREVIEW_TOOLS) {
    assert.equal(READ_TOOLS.has('get_local_voice_status'), true); assert.equal(READ_TOOLS.has('get_create_models'), true)
    assert.equal(SAFE_PREVIEW_TOOLS.has('generate_local_voice'), true); assert.equal(SAFE_PREVIEW_TOOLS.has('generate_create_media'), true)
    assert.equal(READ_TOOLS.has('generate_local_voice'), false); assert.equal(READ_TOOLS.has('generate_create_media'), false)
  }
  const { isAutoApprovableEdit } = require('../electron/connectedAgentEditPolicy.cjs')
  assert.equal(isAutoApprovableEdit('generate_local_voice', { text: 'Hi', previewOnly: false }), false)
  assert.equal(isAutoApprovableEdit('generate_create_media', { planId: 'p', previewOnly: false }), false)
})
