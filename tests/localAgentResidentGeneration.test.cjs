'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { sendLocalWithTools } = require('../electron/connectedAgentLocalTools.cjs')
const { registerGenerationSpendingIpc } = require('../electron/generationSpending.cjs')

const json = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
const toolCall = (id, name) => ({ id, type: 'function', function: { name, arguments: '{}' } })
const graph = { '1': { class_type: 'KSampler', inputs: { seed: 42 } }, '2': { class_type: 'SaveImage', inputs: { images: ['1', 0] } } }
const schema = name => ({ name, description: name, inputSchema: { type: 'object', properties: {} } })

test('desktop entry point does not attach the experimental model-memory coordinator', () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8')
  assert.doesNotMatch(source, /require\(['"]\.\/localAgent(?:GpuCoordinator|ModelRuntime)\.cjs['"]\)/)
  assert.doesNotMatch(source, /\b(?:generationResources|localGpuCoordinator)\s*:/)
  assert.doesNotMatch(source, /\bcreateLocalAgent(?:GpuCoordinator|ModelRuntime)\s*\(/)
  assert.match(source, /registerGenerationSpendingIpc\(/)
  assert.match(source, /registerConnectedAgentIpc\(/)
})

for (const status of ['running', 'error']) {
  test(`tool-driven generation leaves model resident and answers while job is ${status}`, async () => {
    const calls = [], ledger = [], toolResults = []
    const endpoint = 'http://127.0.0.1:8188'
    const model = 'user-selected-model:custom-32k'
    const contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false, send() {} })
    const window = { webContents: contents, isDestroyed: () => false }
    const messages = [
      { tool_calls: [toolCall('submit-once', 'queue_prompt_generation_batch')] },
      { tool_calls: [toolCall('inspect-once', 'get_generation_status')] },
      { content: status === 'running' ? 'The image is still generating; no result yet.' : 'Generation failed: out of memory. No retry was submitted.' },
    ]
    const fetchImpl = async (url, options) => {
      calls.push({ url, method: options.method || 'GET' })
      if (url === `${endpoint}/object_info`) return json({
        KSampler: { name: 'KSampler', python_module: 'nodes' }, SaveImage: { name: 'SaveImage', python_module: 'nodes' },
      })
      if (url === `${endpoint}/prompt`) {
        assert.equal(ledger.length, 1, 'durable beforeSubmit still runs before generation')
        assert.deepEqual(JSON.parse(options.body).prompt, graph)
        return json({ prompt_id: 'resident-model-prompt', number: 0, node_errors: {} })
      }
      assert.equal(url, 'http://127.0.0.1:1234/v1/chat/completions', 'no LM load/unload, Comfy /free, or GPU polling request')
      assert.equal(JSON.parse(options.body).model, model, 'preserve the user-selected instance on every prediction')
      const message = messages.shift()
      assert.ok(message, 'no repeated prediction or submission')
      return json({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] })
    }
    const manager = registerGenerationSpendingIpc({
      ipcMain: { handle() {}, removeHandler() {} }, getMainWindow: () => window,
      getEndpoint: () => endpoint, readPolicy: () => 'local-only',
      getContext: () => ({ session: 's', projectKey: '/synthetic/project', timelineId: 't' }),
      beforeSubmit: detail => ledger.push(detail), afterSubmit: detail => ledger.push(detail), fetchImpl,
    })
    try {
      const result = await sendLocalWithTools({
        model, endpoint: 'http://127.0.0.1:1234/v1', context: '{}', images: [],
        messages: [{ role: 'user', content: 'Use queue_prompt_generation_batch once, then get_generation_status. Report the observed state without retrying.' }],
      }, { fetchImpl, timeoutMs: 2000, toolSession: {
        listTools: async () => [schema('queue_prompt_generation_batch'), schema('get_generation_status')],
        callTool: async name => {
          let value
          if (name === 'queue_prompt_generation_batch') {
            value = await manager.queueFromMain({ requestId: 'submit-resident-once', endpoint, clientId: 'synthetic-client', workflow: graph })
            assert.equal(value.success, true)
            assert.equal(value.body.prompt_id, 'resident-model-prompt')
          } else {
            assert.equal(name, 'get_generation_status')
            value = { status, promptId: 'resident-model-prompt', resultAssetIds: [], ...(status === 'error' ? { error: 'out of memory' } : {}) }
          }
          toolResults.push(value)
          return { content: [{ type: 'text', text: JSON.stringify(value) }] }
        },
      } })
      assert.match(result.text, status === 'running' ? /still generating/ : /out of memory/)
      assert.equal(toolResults.length, 2)
      assert.equal(ledger.length, 2)
      assert.equal(messages.length, 0)
      assert.deepEqual(calls.filter(call => call.method === 'POST').map(call => call.url), [
        'http://127.0.0.1:1234/v1/chat/completions', `${endpoint}/prompt`,
        'http://127.0.0.1:1234/v1/chat/completions', 'http://127.0.0.1:1234/v1/chat/completions',
      ])
    } finally { manager.dispose() }
  })
}
