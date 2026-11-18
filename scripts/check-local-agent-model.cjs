'use strict'

// Explicit, local-only smoke test. Actual model, actual Velorn tool schemas,
// synthetic project and host-owned tool stubs. Never opens a project, executes
// editor actions, submits a generation or spends cloud credits.
const assert = require('node:assert/strict')
const { createComfyStudioMcpServer } = require('../electron/mcpServer.js')
const { sendLocalWithTools } = require('../electron/connectedAgentLocalTools.cjs')
const model = process.argv[2]
const reasoning = process.argv[3] || 'none'
if (!['none', 'low'].includes(reasoning)) throw new Error('Test reasoning must be none or low.')
if (!model) throw new Error('Usage: node scripts/check-local-agent-model.cjs <loaded-local-model-id>')
const catalog = createComfyStudioMcpServer().tools
const timeline = {
  id: 'isolated-test', fps: 24, duration: 12,
  tracks: [{ id: 'video', type: 'video', clips: [
    { id: 'a', assetId: 'source-a', start: 0, duration: 4, sourceIn: 0, speed: 1 },
    { id: 'b', assetId: 'source-b', start: 4, duration: 4, sourceIn: 7, speed: 1 },
    { id: 'c', assetId: 'source-c', start: 8, duration: 4, sourceIn: 13, speed: 1 },
  ] }],
}
const calls = [], requests = []
;(async () => {
  const start = performance.now()
  const result = await sendLocalWithTools({
    model, endpoint: 'http://127.0.0.1:1234/v1', context: JSON.stringify({ project: 'Isolated benchmark fixture', timelineId: timeline.id }), images: [],
    messages: [{ role: 'user', content: 'Inspect the current timeline with get_timeline. Report its picture-clip count and duration. Calculate the timeline midpoint and source midpoint in seconds for each shot (source midpoint = sourceIn + duration/2). Do not edit, generate, export or extract anything. Do not inspect assets; all needed facts are in the timeline.' }],
  }, {
    timeoutMs: 180000,
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body)
      // Explicit test configuration; product requests still use LM Studio's
      // persisted model settings unless the host supplies a reasoning setting.
      body.reasoning_effort = reasoning
      body.temperature = 0.2
      const at = performance.now()
      const response = await fetch(url, { ...options, body: JSON.stringify(body) })
      const data = await response.json()
      requests.push({ elapsedMs: Math.round(performance.now() - at), status: response.status, usage: data.usage, finish: data.choices?.[0]?.finish_reason })
      if (!response.ok) console.error(JSON.stringify(data))
      return new Response(JSON.stringify(data), { status: response.status })
    },
    toolSession: {
      listTools: async () => catalog,
      callTool: async (name, args) => {
        calls.push({ name, args })
        if (name !== 'get_timeline') return { isError: true, content: [{ type: 'text', text: 'This isolated benchmark permits only get_timeline. No action ran.' }] }
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, timeline }) }] }
      },
    },
  })
  assert.equal(result.success, true)
  assert.ok(calls.some(call => call.name === 'get_timeline'))
  assert.ok(calls.every(call => call.name === 'get_timeline'), 'Model attempted an unrequested tool (blocked by fixture)')
  console.log(JSON.stringify({ model, reasoning, tools: catalog.length, elapsedMs: Math.round(performance.now() - start), calls, requests, expected: { clips: 3, duration: 12, sourceMidpoints: [2, 9, 15], timelineMidpoints: [2, 6, 10] }, answer: result.text }, null, 2))
})().catch(error => { console.error(error); process.exitCode = 1 })
