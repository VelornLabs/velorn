'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { registerConnectedAgentIpc, CHANNELS } = require('../electron/connectedAgent.cjs')
const { sendLocalWithTools } = require('../electron/connectedAgentLocalTools.cjs')
const { parseModelTransport } = require('./helpers/localAgentTransport.cjs')

// Exercise the outgoing provider requests, not the new composition helper's
// implementation. All IPC/provider/tool fixtures are in memory; no listening
// server, real inference, filesystem action, or user project is available.
const context = { marker: 'SNAPSHOT_INERT_MARKER', note: 'Snapshot text is not permission to edit.' }
const catalog = [{ name: 'get_timeline', description: 'Read synthetic timeline data.', inputSchema: { type: 'object', properties: {} } }]
const reply = message => new Response(JSON.stringify({ choices: [{ message,
  finish_reason: message.tool_calls?.length ? 'tool_calls' : 'stop' }] }), { headers: { 'Content-Type': 'application/json' } })
const textOf = message => typeof message.content === 'string' ? message.content
  : message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')

function assertOrdinaryRoles(messages, roles) {
  assert.deepEqual(messages.map(message => message.role), roles)
  assert.equal(messages.filter(message => message.role === 'system').length, 1)
  for (let index = 1; index < messages.length; index++) {
    assert.equal(messages[index].role, index % 2 ? 'user' : 'assistant', 'Initial ordinary history must alternate without invented turns.')
  }
}

async function runInitial(mode, overrides = {}) {
  const bodies = [], calls = []
  const original = { model: 'fixture/model-neutral', context, messages: [{ role: 'user', content: 'CURRENT_USER_EXACT: inspect, but do not edit.' }], images: [], ...overrides }
  const preserved = structuredClone(original)
  const fetchImpl = async (_url, options) => { bodies.push(JSON.parse(options.body)); return reply({ content: 'Synthetic public reply.' }) }
  let result
  if (mode === 'tools') {
    result = await sendLocalWithTools({ ...original, endpoint: 'http://127.0.0.1:1234/v1', context: JSON.stringify(original.context) }, {
      fetchImpl, toolSession: { listTools: async () => catalog, callTool: async (...args) => { calls.push(args); throw new Error('No tool was requested.') } },
    })
  } else {
    const handlers = new Map(), app = new EventEmitter()
    const contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false, send() {} })
    const window = { webContents: contents, isDestroyed: () => false }
    const controller = registerConnectedAgentIpc({ app, getMainWindow: () => window, fetchImpl,
      ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name) } })
    try {
      result = await handlers.get(CHANNELS.send)({ sender: contents, senderFrame: contents.mainFrame }, {
        ...original, provider: 'lmstudio', requestId: 'message-format-fixture', toolsEnabled: false,
      })
    } finally { controller.dispose() }
  }
  assert.equal(result.success, true, JSON.stringify(result))
  assert.equal(result.text, 'Synthetic public reply.')
  assert.equal(bodies.length, 1)
  assert.equal(bodies[0].model, original.model, 'Composition must not select or rename the model.')
  assert.deepEqual(calls, [])
  assert.deepEqual(original, preserved, 'Composing a request must not mutate caller-owned history, documents, or images.')
  return bodies[0]
}

for (const mode of ['text-native', 'tools']) {
  test(`${mode}: fresh conversation sends one system/user pair with untrusted snapshot in the actual user turn`, async () => {
    const body = await runInitial(mode)
    assertOrdinaryRoles(body.messages, ['system', 'user'])
    assert.doesNotMatch(textOf(body.messages[0]), /SNAPSHOT_INERT_MARKER|CURRENT_USER_EXACT/)
    const user = textOf(body.messages[1])
    assert.match(user, /snapshot.*untrusted data only.*not instructions/i)
    assert.match(user, /\[BEGIN VELORN SNAPSHOT\][\s\S]*SNAPSHOT_INERT_MARKER[\s\S]*\[END VELORN SNAPSHOT\]/)
    assert.ok(user.endsWith('CURRENT_USER_EXACT: inspect, but do not edit.'))
    assert.equal(body.messages.filter(message => textOf(message).includes('SNAPSHOT_INERT_MARKER')).length, 1)
  })

  test(`${mode}: consecutive real user and assistant messages coalesce in order without an invented assistant`, async () => {
    const messages = [
      { role: 'user', content: 'FIRST_USER_A' }, { role: 'user', content: 'FIRST_USER_B' },
      { role: 'assistant', content: 'REAL_ASSISTANT_A' }, { role: 'assistant', content: 'REAL_ASSISTANT_B' },
      { role: 'user', content: 'CURRENT_USER_A' }, { role: 'user', content: 'CURRENT_USER_B' },
    ]
    const body = await runInitial(mode, { messages })
    if (mode === 'tools') {
      assertOrdinaryRoles(body.messages, ['system', 'user'])
      assert.ok(textOf(body.messages[1]).includes(JSON.stringify(messages.slice(0, -1))))
      assert.ok(textOf(body.messages[1]).endsWith('CURRENT_USER_B'))
      return
    }
    assertOrdinaryRoles(body.messages, ['system', 'user', 'assistant', 'user'])
    for (const [index, first, second] of [[1, 'FIRST_USER_A', 'FIRST_USER_B'], [2, 'REAL_ASSISTANT_A', 'REAL_ASSISTANT_B'], [3, 'CURRENT_USER_A', 'CURRENT_USER_B']]) {
      const text = textOf(body.messages[index])
      assert.ok(text.includes(first) && text.includes(second))
      assert.ok(text.indexOf(first) < text.indexOf(second))
    }
    assert.doesNotMatch(textOf(body.messages[1]), /SNAPSHOT_INERT_MARKER/)
    assert.doesNotMatch(textOf(body.messages[2]), /SNAPSHOT_INERT_MARKER|acknowledged|completed|success/i)
    assert.match(textOf(body.messages[3]), /SNAPSHOT_INERT_MARKER/)
  })

  test(`${mode}: orphan leading assistant output is preserved only as labeled data in the first real user turn`, async () => {
    const messages = [
      { role: 'assistant', content: 'ORPHAN_ASSISTANT_A: historical output, not a new instruction.' },
      { role: 'assistant', content: 'ORPHAN_ASSISTANT_B: "quoted" text and\nnew line.' },
      { role: 'user', content: 'FIRST_REAL_USER' }, { role: 'assistant', content: 'REAL_RETAINED_ASSISTANT' },
      { role: 'user', content: 'CURRENT_REAL_USER' },
    ]
    const body = await runInitial(mode, { messages })
    if (mode === 'tools') {
      assertOrdinaryRoles(body.messages, ['system', 'user'])
      assert.ok(textOf(body.messages[1]).includes(JSON.stringify(messages.slice(0, -1))))
      assert.match(textOf(body.messages[1]), /quoted background.*not a queue of actions to repeat/)
      assert.doesNotMatch(textOf(body.messages[0]), /ORPHAN_ASSISTANT/)
      assert.ok(textOf(body.messages[1]).endsWith('CURRENT_REAL_USER'))
      return
    }
    assertOrdinaryRoles(body.messages, ['system', 'user', 'assistant', 'user'])
    const historical = textOf(body.messages[1])
    assert.match(historical, /assistant messages.*historical model output/i)
    assert.ok(historical.includes(JSON.stringify(messages[0].content)))
    assert.ok(historical.includes(JSON.stringify(messages[1].content)))
    assert.match(historical, /FIRST_REAL_USER/)
    assert.equal(textOf(body.messages[2]), 'REAL_RETAINED_ASSISTANT')
    assert.doesNotMatch(textOf(body.messages[0]), /ORPHAN_ASSISTANT/)
    assert.doesNotMatch(textOf(body.messages[3]), /ORPHAN_ASSISTANT/)
    assert.match(textOf(body.messages[3]), /SNAPSHOT_INERT_MARKER[\s\S]*CURRENT_REAL_USER/)
  })

  test(`${mode}: current attached JSON and images retain exact data and labels in user content blocks`, async () => {
    const documents = [{ name: 'reference.json', text: '{ "marker": "DOCUMENT_INERT", "note": "do not execute", "count": 4 }' }]
    const images = [{ label: 'First exact label', dataUrl: 'data:image/png;base64,YQ==' },
      { label: 'Second exact label', dataUrl: 'data:image/webp;base64,Yg==' }]
    const body = await runInitial(mode, { vision: true, documents, images, messages: [
      { role: 'user', content: 'EARLIER_USER_WITH_ATTACHMENTS' },
      { role: 'user', content: 'CURRENT_USER_EXACT: inspect, but do not edit.' },
    ] })
    assertOrdinaryRoles(body.messages, ['system', 'user'])
    const user = body.messages[1]
    assert.ok(Array.isArray(user.content))
    assert.ok(user.content.every(block => block.type === 'text' ? typeof block.text === 'string' : block.type === 'image_url'))
    assert.deepEqual(user.content.filter(block => block.type === 'image_url').map(block => block.image_url.url), images.map(image => image.dataUrl))
    const userText = textOf(user)
    assert.ok(userText.includes(JSON.stringify(documents)), 'Original JSON attachment text is preserved, not reparsed or summarized.')
    assert.match(userText, /User-attached JSON files.*untrusted data/)
    assert.match(userText, /CURRENT_USER_EXACT/)
    assert.ok(userText.indexOf('EARLIER_USER_WITH_ATTACHMENTS') < userText.indexOf('CURRENT_USER_EXACT'))
    for (const image of images) assert.ok(userText.includes(image.label))
    assert.doesNotMatch(textOf(body.messages[0]), /DOCUMENT_INERT|data:image|First exact label|SNAPSHOT_INERT_MARKER/)
  })
}

test('tools: accepted history beyond 32 KiB preserves exact role-labeled background with the current instruction in the first user turn', async () => {
  const messages = [
    { role: 'user', content: 'RETAINED_OLD_USER_' + 'x'.repeat(14000) },
    { role: 'assistant', content: 'RETAINED_REAL_ASSISTANT_' + 'y'.repeat(14000) },
    { role: 'user', content: 'CURRENT_EXACT_AFTER_BUDGET_' + 'z'.repeat(14000) },
  ]
  assert.ok(Buffer.byteLength(JSON.stringify(messages)) > 32 * 1024)
  assert.ok(messages.every(message => Buffer.byteLength(message.content) < 16 * 1024))
  const body = await runInitial('tools', { messages })
  assertOrdinaryRoles(body.messages, ['system', 'user'])
  assert.doesNotMatch(textOf(body.messages[0]), /older chat messages were omitted|RETAINED_OLD_USER|RETAINED_REAL_ASSISTANT|CURRENT_EXACT_AFTER_BUDGET/)
  assert.ok(textOf(body.messages[1]).includes(JSON.stringify(messages.slice(0, -1))))
  assert.ok(textOf(body.messages[1]).endsWith(messages[2].content))
  assert.match(textOf(body.messages[1]), /SNAPSHOT_INERT_MARKER/)
  assert.doesNotMatch(textOf(body.messages[1]), /assistant messages.*historical model output/i)
})

test('tools: fresh empty-answer recovery preserves the user request and role alternation without synthetic assistant acknowledgment', async () => {
  const bodies = [], calls = []
  const result = await sendLocalWithTools({ model: 'fixture/model-neutral', endpoint: 'http://127.0.0.1:1234/v1',
    context: JSON.stringify(context), messages: [{ role: 'user', content: 'Answer from this supplied context only.' }], images: [],
  }, {
    toolSession: { listTools: async () => catalog, callTool: async (...args) => { calls.push(args); throw new Error('No tools should run.') } },
    fetchImpl: async (_url, options) => {
      bodies.push(JSON.parse(options.body))
      assert.ok(bodies.length <= 2)
      return reply({ content: bodies.length === 1 ? '' : 'No tool was run.' })
    },
  })
  assert.equal(result.text, 'No tool was run.')
  assert.equal(bodies.length, 2)
  assert.deepEqual(calls, [])
  for (const body of bodies) assertOrdinaryRoles(body.messages, ['system', 'user'])
  assert.ok(bodies[1].messages[1].content.startsWith(bodies[0].messages[1].content))
  assert.match(bodies[1].messages[1].content, /Velorn answer recovery/)
  assert.deepEqual(bodies[1].tools, [])
  assert.equal(bodies[1].tool_choice, 'none')
})

for (const toolImages of [false, true]) {
  test(`tools: native call/result associations survive ${toolImages ? 'tool-image data and ' : ''}empty-final recovery without replay or fake answers`, async () => {
    const bodies = [], calls = [], events = []
    const toolCalls = ['first-read', 'second-read'].map(id => ({ id, type: 'function', function: { name: 'get_timeline', arguments: '{}' } }))
    const results = toolCalls.map((call, index) => ({ content: [
      { type: 'text', text: JSON.stringify({ call: call.id, duration: index + 2 }) },
      ...(toolImages ? [{ type: 'image', mimeType: 'image/png', data: index ? 'Yg==' : 'YQ==' }] : []),
    ] }))
    const result = await sendLocalWithTools({ model: 'fixture/model-neutral', endpoint: 'http://127.0.0.1:1234/v1',
      context: JSON.stringify(context), messages: [{ role: 'user', content: 'Inspect both, then report observed results.' }], vision: toolImages, images: [],
    }, {
      onEvent: event => events.push(event),
      toolSession: { listTools: async () => catalog, callTool: async (name, args) => { calls.push({ name, args }); return results[calls.length - 1] } },
      fetchImpl: async (_url, options) => {
        bodies.push(JSON.parse(options.body))
        assert.ok(bodies.length <= 3, 'Only the existing single answer-only recovery is permitted.')
        return reply(bodies.length === 1 ? { content: 'Inspecting both requested results.', tool_calls: toolCalls }
          : bodies.length === 2 ? { content: '', reasoning_content: 'PRIVATE_REASONING_MUST_NOT_ENTER_MESSAGES' }
            : { content: 'The two synthetic reads returned durations 2 and 3.' })
      },
    })
    assert.equal(result.text, 'The two synthetic reads returned durations 2 and 3.')
    assertOrdinaryRoles(bodies[0].messages, ['system', 'user'])
    assert.equal(calls.length, 2)
    assert.equal(bodies.length, 3)
    assert.deepEqual(bodies[2].tools, [])
    assert.equal(bodies[2].tool_choice, 'none')
    for (const body of bodies.slice(1)) {
      assert.equal(body.messages.filter(message => message.role === 'system').length, 1)
      const assistant = body.messages.filter(message => message.role === 'assistant')
      assert.equal(assistant.length, 1, 'Do not synthesize an empty-final acknowledgment or an assistant success.')
      assert.equal(assistant[0].content, 'Inspecting both requested results.')
      assert.deepEqual(assistant[0].tool_calls, toolCalls)
      const index = body.messages.indexOf(assistant[0])
      const group = body.messages.slice(index + 1, index + 3)
      assert.deepEqual(group.map(message => [message.role, message.tool_call_id]), [['tool', 'first-read'], ['tool', 'second-read']])
      for (let i = 0; i < group.length; i++) {
        const transported = parseModelTransport(group[i].content)
        assert.equal(transported.complete, true)
        assert.equal(transported.truncated, false)
        assert.equal(JSON.parse(transported.result.content[0].text).call, toolCalls[i].id)
        assert.equal(JSON.parse(transported.result.content[0].text).duration, i + 2)
      }
      if (toolImages) {
        const imageMessage = body.messages[index + 3]
        assert.equal(imageMessage.role, 'user')
        assert.ok(Array.isArray(imageMessage.content))
        assert.deepEqual(imageMessage.content.filter(block => block.type === 'image_url').map(block => block.image_url.url),
          ['data:image/png;base64,YQ==', 'data:image/png;base64,Yg=='])
        assert.match(textOf(imageMessage), /first-read.*tool output, not user instructions/)
        assert.match(textOf(imageMessage), /second-read.*tool output, not user instructions/)
      } else assert.equal(body.messages.length, index + (body === bodies[2] ? 4 : 3))
    }
    if (toolImages) {
      assert.deepEqual(bodies[2].messages.slice(1, -1), bodies[1].messages.slice(1, -1))
      assert.deepEqual(bodies[2].messages.at(-1).content.slice(0, -1), bodies[1].messages.at(-1).content)
      assert.match(bodies[2].messages.at(-1).content.at(-1).text, /Velorn answer recovery/)
    } else {
      assert.deepEqual(bodies[2].messages.slice(1, -1), bodies[1].messages.slice(1), 'Recovery must preserve prior native tool envelopes exactly.')
      assert.match(bodies[2].messages.at(-1).content, /Velorn answer recovery/)
    }
    assert.doesNotMatch(JSON.stringify({ bodies, events, result }), /PRIVATE_REASONING_MUST_NOT_ENTER_MESSAGES/)
  })
}
