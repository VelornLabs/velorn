'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { sendLocalWithTools } = require('../electron/connectedAgentLocalTools.cjs')
const { createComfyStudioMcpServer } = require('../electron/mcpServer.js')
const { parseModelTransport, unpackLocalUserMessage } = require('./helpers/localAgentTransport.cjs')
const catalog = createComfyStudioMcpServer({ performAction: () => assert.fail('No real actions in fixture') }).tools
const history = [
  { role: 'user', content: 'Create Short Music Video Test, 1080 by 1920 at 24 FPS.' },
  { role: 'assistant', content: 'Created and activated timeline-existing. It is empty.' },
  { role: 'user', content: 'Now search Pexels for ten drone videos of city streets and buildings from above.' },
]
const reply = message => new Response(JSON.stringify({ choices: [{ message,
  finish_reason: message.tool_calls?.length ? 'tool_calls' : 'stop' }] }))
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })

test('stock follow-up survives repeated documentation and first-user-preserving truncation without replaying creation', async () => {
  const bodies = [], calls = []
  const original = structuredClone(history)
  const result = await sendLocalWithTools({ model: 'model-neutral', endpoint: 'http://127.0.0.1:1234/v1', fullAccess: true,
    context: JSON.stringify({ currentTimeline: { id: 'timeline-existing' } }), messages: history,
  }, {
    toolSession: { listTools: async () => catalog, callTool: async (name, args) => {
      calls.push({ name, args })
      assert.equal(name, 'search_stock_media')
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, results: [], mediaType: args.mediaType }) }] }
    } },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body); bodies.push(body)
      // Model the server's first-user retention: deleting intermediate exchanges
      // must never leave the old create request as the only active user task.
      const retained = [body.messages[0], body.messages.find(message => message.role === 'user')]
      assert.equal(unpackLocalUserMessage(retained[1]).content, history.at(-1).content)
      assert.ok(retained[1].content.includes(JSON.stringify(history.slice(0, -1))))
      assert.doesNotMatch(retained[0].content, /timeline-existing|Create Short Music Video Test/)
      if (bodies.length <= 10) return reply({ tool_calls: [call(`lookup-${bodies.length}`, 'discover_velorn_tools', {
        names: ['search_stock_media'], query: 'drone city street buildings above',
      })] })
      if (bodies.length === 11) {
        const direct = body.tools.find(tool => tool.function.name === 'search_stock_media')
        assert.deepEqual(direct.function.parameters, catalog.find(tool => tool.name === 'search_stock_media').inputSchema)
        assert.equal(body.tools.filter(tool => tool.function.name === 'search_stock_media').length, 1)
        assert.ok(body.tools.some(tool => tool.function.name === 'create_timeline'), 'Do not hide other capabilities.')
        const docs = body.messages.filter(message => message.role === 'tool').map(message => parseModelTransport(message.content))
        assert.ok(docs.every(result => result.available && !result.actionExecuted && !result.isError))
        assert.ok(docs.slice(1).every(result => result.tools.length === 0 && result.alreadyDocumented.includes('search_stock_media')))
        assert.ok(Buffer.byteLength(body.messages.at(-1).content) < 1000, 'Repeated lookups must not repeat full catalog/documentation.')
        return reply({ tool_calls: [call('search', 'search_stock_media', { query: 'drone city buildings', mediaType: 'videos', perPage: 10 })] })
      }
      assert.equal(bodies.length, 12)
      return reply({ content: 'No matching stock videos were returned. The existing timeline was left unchanged.' })
    },
  })
  assert.equal(result.success, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].args.mediaType, 'videos')
  assert.deepEqual(history, original)
})

test('brief follow-ups retain the earlier plan as data, not a fabricated assistant or system instruction', async () => {
  const messages = [...history.slice(0, 2), { role: 'user', content: 'Use that timeline. Apply the plan we agreed on.' }]
  let outgoing
  await sendLocalWithTools({ model: 'model-neutral', endpoint: 'http://127.0.0.1:1234/v1', context: '{}', messages }, {
    toolSession: { listTools: async () => catalog, callTool: () => assert.fail('No tool requested') },
    fetchImpl: async (_url, options) => { outgoing = JSON.parse(options.body); return reply({ content: 'Acknowledged.' }) },
  })
  assert.deepEqual(outgoing.messages.map(message => message.role), ['system', 'user'])
  assert.ok(outgoing.messages[1].content.includes(JSON.stringify(messages.slice(0, -1))))
  assert.equal(unpackLocalUserMessage(outgoing.messages[1]).content, messages.at(-1).content)
})
