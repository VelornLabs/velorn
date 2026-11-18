import test from 'node:test'
import assert from 'node:assert/strict'
import {
  cleanScriptAnswer, countScriptShots, createBusyWatcher, describeVeloFailure, resetVeloWatcherForTests,
  splitBriefIntoMessages, writeScriptWithVelo,
} from '../src/services/veloScriptWriter.mjs'

const SCRIPT = 'Shot 1: Opening\nShot type: performance\nLength: 4\n\nShot 2: Street\nShot type: b_roll\nLength: 3'

function fakeApi(replies) {
  const listeners = new Set()
  const sent = []
  return {
    sent,
    emit: (event) => listeners.forEach((listener) => listener(event)),
    onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    send: async (payload) => {
      sent.push(payload)
      const reply = replies.shift()
      return typeof reply === 'function' ? reply(payload) : reply
    },
  }
}

test('a short brief is one message and a long one is split under the limit', () => {
  assert.deepEqual(splitBriefIntoMessages('  hello  '), [{ role: 'user', content: 'hello' }])
  assert.deepEqual(splitBriefIntoMessages(''), [])
  const long = Array.from({ length: 400 }, (_, index) => `line ${index} ${'x'.repeat(90)}`).join('\n')
  const parts = splitBriefIntoMessages(long)
  assert.ok(parts.length >= 3)
  for (const part of parts) assert.ok(new TextEncoder().encode(part.content).length <= 16 * 1024)
  assert.match(parts[0].content, /part 1 of \d+ — more follows/)
  assert.match(parts.at(-1).content, /this is the last part/)
  assert.ok(parts.map((part) => part.content).join('\n').includes('line 399'))
  assert.ok(splitBriefIntoMessages('y'.repeat(40000)).length >= 3)
})

test('answers are unwrapped and shots are counted', () => {
  assert.equal(cleanScriptAnswer('```text\n' + SCRIPT + '\n```'), SCRIPT)
  assert.equal(cleanScriptAnswer('  ' + SCRIPT + '\n'), SCRIPT)
  assert.equal(countScriptShots(SCRIPT), 2)
  assert.equal(countScriptShots('## Shot 3: x\n**Shot 4** y'), 2)
  assert.equal(countScriptShots('Here is a great idea for your video.'), 0)
})

test('failures are explained in plain words', () => {
  assert.match(describeVeloFailure({ code: 'LUNA_EXHAUSTED' }), /allowance is used up/)
  assert.match(describeVeloFailure({ code: 'LUNA_NOT_ELIGIBLE' }), /does not have Velo/)
  assert.equal(describeVeloFailure({ code: 'ODD', error: 'Specific reason.' }), 'Specific reason.')
  assert.match(describeVeloFailure({}), /could not write the script/)
})

test('the busy watcher only notices other requests, and only for a few seconds', () => {
  let clock = 1000
  const watcher = createBusyWatcher(() => clock)
  assert.equal(watcher.busy(), false)
  watcher.mine.add('mine')
  watcher.see({ requestId: 'mine' })
  assert.equal(watcher.busy(), false)
  watcher.see({ requestId: 'chat-1' })
  assert.equal(watcher.busy(), true)
  clock += 5000
  assert.equal(watcher.busy(), false)
})

test('writing a script sends one quiet Velo request and returns the script', async () => {
  resetVeloWatcherForTests()
  const api = fakeApi([(payload) => { api.emit({ requestId: payload.requestId, type: 'delta', text: 'Shot 1' }); return { success: true, text: SCRIPT } }])
  const seen = []
  const result = await writeScriptWithVelo({ api, brief: 'the brief', onText: (text) => seen.push(text), makeId: () => 'abc' })
  assert.deepEqual(result, { success: true, text: SCRIPT, shots: 2 })
  assert.deepEqual(seen, ['Shot 1'])
  assert.deepEqual(api.sent[0], { requestId: 'mvscript-abc', conversationId: 'mvscript-abc', provider: 'luna', toolsEnabled: false, vision: false, longReply: true, messages: [{ role: 'user', content: 'the brief' }], context: {} })
})

test('an answer that is not a script gets one reminder, never more', async () => {
  resetVeloWatcherForTests()
  const recovered = fakeApi([{ success: true, text: 'Sure! Here are some thoughts.' }, { success: true, text: SCRIPT }])
  assert.equal((await writeScriptWithVelo({ api: recovered, brief: 'b' })).success, true)
  assert.equal(recovered.sent.length, 2)
  assert.match(recovered.sent[1].messages.at(-1).content, /Return only the director script/)

  resetVeloWatcherForTests()
  const hopeless = fakeApi([{ success: true, text: 'no' }, { success: true, text: 'still no' }, { success: true, text: SCRIPT }])
  const result = await writeScriptWithVelo({ api: hopeless, brief: 'b' })
  assert.equal(result.code, 'BAD_FORMAT')
  assert.equal(hopeless.sent.length, 2)
})

test('it refuses while the chat is using Velo, and reports an empty allowance', async () => {
  resetVeloWatcherForTests()
  const busy = fakeApi([{ success: true, text: SCRIPT }])
  assert.equal((await writeScriptWithVelo({ api: busy, brief: 'b' })).success, true)
  busy.emit({ requestId: 'chat-turn', type: 'delta', text: 'hi' })
  const refused = await writeScriptWithVelo({ api: busy, brief: 'b' })
  assert.equal(refused.code, 'LUNA_BUSY')
  assert.equal(busy.sent.length, 1)

  resetVeloWatcherForTests()
  const empty = fakeApi([{ success: false, code: 'LUNA_EXHAUSTED', error: 'raw' }])
  const out = await writeScriptWithVelo({ api: empty, brief: 'b' })
  assert.equal(out.code, 'LUNA_EXHAUSTED')
  assert.match(out.error, /allowance is used up/)
  assert.equal((await writeScriptWithVelo({ api: {}, brief: 'b' })).code, 'LUNA_UNAVAILABLE')
  resetVeloWatcherForTests()
  assert.equal((await writeScriptWithVelo({ api: fakeApi([]), brief: '  ' })).code, 'EMPTY')
})

test('Stop ends the request Velo is writing and does not try again', async () => {
  resetVeloWatcherForTests()
  const stopper = new AbortController()
  const cancelled = []
  let release
  const sent = []
  const api = {
    onEvent: () => () => {},
    cancel: async (payload) => { cancelled.push(payload.requestId); release({ success: false, code: 'CANCELLED', error: 'raw' }) },
    send: (payload) => { sent.push(payload); return new Promise((resolve) => { release = resolve }) },
  }
  const pending = writeScriptWithVelo({ api, brief: 'b', signal: stopper.signal })
  await new Promise((resolve) => setTimeout(resolve, 0))
  stopper.abort()
  const result = await pending
  assert.deepEqual(result, { success: false, code: 'CANCELLED', error: 'Stopped.' })
  assert.deepEqual(cancelled, [sent[0].requestId])
  assert.equal(sent.length, 1, 'no second try after Stop')
})

test('Stop pressed between two tries prevents the second, and an early Stop sends nothing', async () => {
  resetVeloWatcherForTests()
  const stopper = new AbortController()
  const sent = []
  const api = { onEvent: () => () => {}, cancel: async () => {}, send: async (payload) => { sent.push(payload); stopper.abort(); return { success: true, text: 'not a script' } } }
  assert.equal((await writeScriptWithVelo({ api, brief: 'b', signal: stopper.signal })).code, 'CANCELLED')
  assert.equal(sent.length, 1)

  resetVeloWatcherForTests()
  const early = new AbortController(); early.abort()
  const quiet = { onEvent: () => () => {}, send: async () => { throw new Error('should not be called') } }
  assert.equal((await writeScriptWithVelo({ api: quiet, brief: 'b', signal: early.signal })).code, 'CANCELLED')
})
