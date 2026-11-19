'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { sendLocalWithTools, PAGE_TOOL } = require('../electron/connectedAgentLocalTools.cjs')
const { LIMITS } = require('../electron/localAgentToolResults.cjs')
const { parseModelTransport, decodeReadable } = require('./helpers/localAgentTransport.cjs')

const call = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const reply = message => new Response(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls?.length ? 'tool_calls' : 'stop' }] }),
  { headers: { 'Content-Type': 'application/json' } })
const request = model => ({ model, endpoint: 'http://127.0.0.1:1234/v1', context: '{}',
  messages: [{ role: 'user', content: 'Read the result without changing anything.' }], images: [] })
const catalog = [{ name: 'get_timeline', description: 'Inspect timeline data.', inputSchema: { type: 'object', properties: {} } }]
const helperReply = body => parseModelTransport(body.messages.at(-1).content)

for (const model of ['synthetic-small', 'synthetic-large']) {
  test(`${model}: a formerly six-small-page result completes in one host-sized page without replay`, async () => {
    const original = { content: [{ type: 'text', text: 'Exact payload 🎬 '.repeat(810) }], structuredContent: { tail: 'preserve' } }
    const raw = JSON.stringify(original)
    assert.ok(raw.length > LIMITS.inlineChars)
    assert.ok(raw.length - LIMITS.excerptChars <= LIMITS.pageChars)
    let predictions = 0, executions = 0, excerpt
    const result = await sendLocalWithTools(request(model), {
      toolSession: { listTools: async () => catalog, callTool: async name => { assert.equal(name, 'get_timeline'); executions++; return original } },
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body)
        switch (++predictions) {
          case 1:
            assert.ok(!body.tools.some(tool => tool.function.name === 'read_velorn_tool_result'))
            return reply({ tool_calls: [call('inspect', 'get_timeline')] })
          case 2:
            excerpt = parseModelTransport(body.messages.at(-1).content)
            assert.equal(excerpt.complete, false)
            assert.deepEqual(body.tools.find(tool => tool.function.name === 'read_velorn_tool_result'), PAGE_TOOL)
            assert.deepEqual(Object.keys(PAGE_TOOL.function.parameters.properties), ['resultId', 'offset', 'position', 'representation'])
            // A stale model habit can still send this previously valid field.
            // It is validated, then the host—not the model—sizes the page.
            return reply({ tool_calls: [call('page', 'read_velorn_tool_result', { resultId: excerpt.resultId, maxChars: 2000 })] })
          case 3: {
            const page = helperReply(body)
            assert.equal(page.offset, LIMITS.excerptChars)
            assert.ok(page.raw.length > 10000)
            assert.ok(page.raw.length <= LIMITS.pageChars)
            assert.deepEqual(decodeReadable(excerpt.body + page.raw), original)
            assert.equal(page.complete, false)
            assert.equal(page.endOfResult, true)
            assert.equal(page.deliveryProgress.allCharsDelivered, true)
            assert.ok(page.deliveryProgress.newChars > 0)
            return reply({ content: 'Inspected the complete delivered data. No changes made.' })
          }
          default: throw Error('Unexpected repeated prediction')
        }
      },
    })
    assert.equal(result.success, true)
    assert.equal(predictions, 3)
    assert.equal(executions, 1)
  })
}


test('position end uses the exposed tail offset without replaying the original tool', async () => {
  const original = { content: [{ type: 'text', text: `${'middle '.repeat(6000)}CONNECTED_FINAL_VALUE` }] }
  let predictions = 0, executions = 0, excerpt
  const result = await sendLocalWithTools(request('synthetic-tail'), {
    toolSession: { listTools: async () => catalog, callTool: async () => { executions++; return original } },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body)
      if (++predictions === 1) return reply({ tool_calls: [call('inspect', 'get_timeline')] })
      if (predictions === 2) {
        excerpt = parseModelTransport(body.messages.at(-1).content)
        assert.equal(excerpt.complete, false)
        assert.equal(excerpt.tailOffset, excerpt.totalChars - LIMITS.pageChars)
        assert.ok(excerpt.tailOffset > excerpt.nextOffset)
        return reply({ tool_calls: [call('tail', 'read_velorn_tool_result', { resultId: excerpt.resultId, offset: 0, position: 'end' })] })
      }
      const page = helperReply(body)
      assert.equal(page.offset, excerpt.tailOffset)
      assert.equal(page.endOffset, excerpt.totalChars)
      assert.equal(page.raw.length, LIMITS.pageChars)
      assert.match(page.raw, /CONNECTED_FINAL_VALUE/)
      assert.equal(page.nextOffset, null)
      assert.equal(page.endOfResult, true)
      assert.equal(page.requestedSelectionComplete, true)
      assert.match(page.nextAction, /answer now; do not request position:end again/)
      assert.equal(page.deliveryProgress.allCharsDelivered, false)
      assert.ok(page.deliveryProgress.newChars > 0)
      return reply({ content: 'Inspected the final page without replaying the tool.' })
    },
  })
  assert.equal(result.success, true)
  assert.equal(predictions, 3)
  assert.equal(executions, 1)
})

test('model reader rejects invalid legacy sizing and recovers from the same retained result', async () => {
  const original = { content: [{ type: 'text', text: 'x'.repeat(13000) }] }
  let predictions = 0, executions = 0, resultId
  await sendLocalWithTools(request('synthetic-model'), {
    toolSession: { listTools: async () => catalog, callTool: async () => { executions++; return original } },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body)
      if (++predictions === 1) return reply({ tool_calls: [call('inspect', 'get_timeline')] })
      if (predictions === 2) {
        resultId = parseModelTransport(body.messages.at(-1).content).resultId
        return reply({ tool_calls: [call('invalid_page', 'read_velorn_tool_result', { resultId, maxChars: LIMITS.pageChars + 1 })] })
      }
      if (predictions === 3) {
        const error = helperReply(body)
        assert.equal(error.isError, true)
        assert.equal(error.error.code, 'LOCAL_TOOL_RESULT_ARGUMENTS')
        assert.match(error.error.message, /Velorn manages the bounded page size/)
        assert.doesNotMatch(error.error.message, /maxChars|page size from|1 to 12000/)
        assert.equal(error.requestedResult.nextUnreadOffset, LIMITS.excerptChars)
        assert.equal(error.requestedResult.resultId, resultId)
        return reply({ tool_calls: [call('valid_page', 'read_velorn_tool_result', { resultId })] })
      }
      const page = helperReply(body)
      assert.equal(page.offset, LIMITS.excerptChars)
      assert.equal(page.endOfResult, true)
      assert.ok(page.deliveryProgress.newChars > 0)
      return reply({ content: 'Read the remaining result.' })
    },
  })
  assert.equal(executions, 1)
  assert.equal(predictions, 4)
})
