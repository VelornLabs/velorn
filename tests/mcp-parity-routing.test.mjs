import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createComfyStudioMcpServer } = require('../electron/mcpServer')
const parity = require('../electron/mcpParityTools.cjs')
const generationRunTools = require('../electron/mcpGenerationRunTools.cjs')
const routerTools = require('../electron/mcpComfyRouterTools.cjs')
const parse = result => JSON.parse(result.content[0].text)
const snapshot = { project: { name: 'Synthetic', path: '/synthetic' }, currentTimeline: { id: 't', clips: [], tracks: [] }, assets: [] }
function harness(performAction) {
  const server = createComfyStudioMcpServer({ performAction }); server.updateSnapshot(snapshot); return server
}

test('public tool names are unique and parity definitions fully replace legacy schemas', () => {
  const server = harness(async () => ({}))
  assert.equal(server.tools.length, new Set(server.tools.map(tool => tool.name)).size)
  assert.equal(server.tools.length, 197)
  for (const tool of routerTools.tools) assert.ok(server.tools.some(entry => entry.name === tool.name))
  assert.ok(server.tools.some(tool => tool.name === 'request_comfy_cloud_setup'))
  assert.ok(server.tools.some(tool => tool.name === 'get_comfy_cloud_setup_status'))
  for (const tool of parity.tools) assert.deepEqual(server.tools.find(item => item.name === tool.name), tool)
  for (const name of parity.writableTools) assert.ok(server.tools.find(tool => tool.name === name).inputSchema.properties.expectedContext)
})
test('every renderer-parity tool routes to its exact renderer action before any legacy implementation', async () => {
  const seen = []
  const server = harness(async request => { seen.push(request); return { success: true } })
  for (const tool of parity.tools.filter(tool => !generationRunTools.nativeToolNames.has(tool.name)
    && !routerTools.nativeToolNames.has(tool.name)
    && !['import_comfyui_run_outputs', 'get_caption_engine_status', 'install_caption_engine'].includes(tool.name))) {
    const result = await server.callTool(tool.name, { marker: tool.name })
    assert.notEqual(result.isError, true)
    assert.equal(seen.at(-1).action, tool.name); assert.equal(seen.at(-1).payload.marker, tool.name)
    assert.equal(seen.at(-1).payload.previewOnly, parity.previewByDefault(tool.name, {}))
  }
})

test('native Runs tools use the manager, default write previews, and keep cached reads repeatable', async () => {
  const native = [], renderer = []
  const generationRuns = {
    list: async args => { native.push(['list', args]); return { success: true, runs: [], updatedAt: '2026-01-01T00:00:00.000Z' } },
    submit: async args => { native.push(['submit', args]); return { success: true, previewOnly: args.previewOnly, runId: 'run-submit' } },
    adopt: async args => { native.push(['adopt', args]); return { success: true, previewOnly: args.previewOnly, run: { id: 'run-adopt' } } },
    recipe: async args => { native.push(['recipe', args]); return { success: true, runId: args.runId, redacted: true, cannotExactReplay: true } },
    control: async args => { native.push(['control', args]); return { success: true, previewOnly: args.previewOnly, runId: args.runId } },
  }
  const server = createComfyStudioMcpServer({ generationRuns, performAction: async request => {
    renderer.push(request)
    return { previewOnly: request.payload.previewOnly, success: true }
  } })
  server.updateSnapshot(snapshot)

  for (let index = 0; index < 2; index++) {
    const read = parse(await server.callTool('get_comfyui_runs', { includeOtherProjects: true }))
    assert.equal(read.success, true)
  }
  assert.deepEqual(native.slice(0, 2), [
    ['list', { includeOtherProjects: true }],
    ['list', { includeOtherProjects: true }],
  ])
  assert.equal(renderer.length, 0)

  assert.equal(parse(await server.callTool('inspect_comfyui_run', { runId: 'run-one', includeOtherProjects: true })).cannotExactReplay, true)
  assert.equal(parse(await server.callTool('queue_comfyui_workflow', { workflow: { '1': { class_type: 'SaveImage', inputs: {} } } })).previewOnly, true)
  assert.equal(parse(await server.callTool('track_comfyui_prompt', { promptId: 'prompt-one' })).previewOnly, true)
  assert.equal(parse(await server.callTool('control_comfyui_run', { runId: 'run-one', operation: 'cancel' })).previewOnly, true)
  assert.deepEqual(native.slice(2), [
    ['recipe', { runId: 'run-one', includeOtherProjects: true }],
    ['submit', { workflow: { '1': { class_type: 'SaveImage', inputs: {} } }, previewOnly: true }],
    ['adopt', { promptId: 'prompt-one', previewOnly: true }],
    ['control', { runId: 'run-one', operation: 'cancel', previewOnly: true }],
  ])

  assert.equal(parse(await server.callTool('queue_comfyui_workflow', {
    workflowJson: '{"1":{"class_type":"SaveImage","inputs":{}}}', inputAssetIds: ['asset-one'],
    targetShotId: 'shot-one', previewOnly: false,
  })).previewOnly, false)
  assert.deepEqual(native.at(-1), ['submit', {
    workflowJson: '{"1":{"class_type":"SaveImage","inputs":{}}}', inputAssetIds: ['asset-one'],
    targetShotId: 'shot-one', previewOnly: false,
  }])

  const importResult = parse(await server.callTool('import_comfyui_run_outputs', { runId: 'run-one' }))
  assert.equal(importResult.previewOnly, true)
  assert.deepEqual(renderer, [{ action: 'import_comfyui_run_outputs', payload: { runId: 'run-one', previewOnly: true } }])

  const before = native.length
  const invalid = await server.callTool('queue_comfyui_workflow', { filePath: '/not-an-mcp-file.json' })
  assert.equal(invalid.isError, true)
  assert.equal(parse(invalid).code, 'GENERATION_RUNS_INVALID_REQUEST')
  assert.equal(native.length, before)
})
test('status operations stay read-only and preview suggestions retain renderer tokens and frozen operands', async () => {
  const seen = []
  const server = harness(async request => {
    seen.push(request)
    return request.action === 'audio_ducking' ? { status: 'completed' } : { previewOnly: true,
      suggestedApplyPayload: { previewToken: 'opaque', clipIds: ['frozen-selection'], expectedContext: { revision: 9 } } }
  })
  const status = parse(await server.callTool('audio_ducking', { operation: 'status', jobId: 'job' }))
  assert.equal(seen[0].payload.previewOnly, undefined); assert.equal(status.previewOnly, false)
  const preview = parse(await server.callTool('set_clip_style', { opacity: 80 }))
  assert.deepEqual(preview.suggestedApplyCall.arguments, { opacity: 80, previewOnly: false,
    previewToken: 'opaque', clipIds: ['frozen-selection'], expectedContext: { revision: 9 } })
})
test('no-project catalog/status/file inspection works but timeline mutation is refused', async () => {
  const calls = []
  const server = createComfyStudioMcpServer({ performAction: async request => { calls.push(request); return {} } })
  for (const name of ['list_fonts', 'list_export_presets', 'get_export_status', 'inspect_export_file']) assert.notEqual((await server.callTool(name)).isError, true)
  assert.equal((await server.callTool('set_clip_style', { opacity: 0, previewOnly: false })).isError, true)
  assert.equal(calls.length, 4)
})
test('source inspection returns native MCP image blocks instead of base64 buried in text', async () => {
  const server = harness(async () => ({ frame: { state: 'ready', dataUrl: 'data:image/jpeg;base64,YWJj' } }))
  const result = await server.callTool('inspect_source_frame', { clipId: 'a' })
  assert.equal(result.content[1].type, 'image'); assert.equal(result.content[1].data, 'YWJj')
  assert.equal(parse(result).result.frame.imageContentIndex, 1)
  assert.equal(result.content[0].text.includes('base64'), false)
})
test('action plans include all new writes and reject overlong plans rather than truncating', async () => {
  const server = harness(async () => ({}))
  const steps = [...parity.writableTools].map(tool => ({ tool }))
  const plan = parse(await server.callTool('run_mcp_action_plan', { steps }))
  assert.equal(plan.previewOnly, true); assert.equal(plan.stepCount, steps.length)
  const tooMany = await server.callTool('run_mcp_action_plan', { steps: Array.from({ length: 51 }, () => ({ tool: 'set_playhead' })), previewOnly: false })
  assert.equal(tooMany.isError, true)
})
test('checkpoint failure prevents every requested mutation', async () => {
  const seen = []
  const server = harness(async ({ action }) => { seen.push(action); return action === 'create_project_checkpoint' ? { success: false } : { context: { revision: 1 } } })
  const result = parse(await server.callTool('run_mcp_action_plan', { previewOnly: false, stopOnError: false, steps: [{ tool: 'set_clip_style', arguments: { clipId: 'a', opacity: 2 } }] }))
  assert.equal(result.success, false); assert.deepEqual(seen, ['get_transport_state', 'create_project_checkpoint'])
})
test('action plan pauses after accepted async job and does not report render completion', async () => {
  const seen = []
  const server = harness(async ({ action }) => { seen.push(action); return action === 'export_timeline' ? { jobId: 'export-1', status: 'running' } : { context: { revision: 1 } } })
  const result = parse(await server.callTool('run_mcp_action_plan', { previewOnly: false, steps: [
    { tool: 'export_timeline', arguments: {} }, { tool: 'set_clip_style', arguments: { clipId: 'a', opacity: 2 } },
  ] }))
  assert.equal(result.executedStepCount, 1); assert.equal(result.awaitingAsyncCompletion.jobId, 'export-1')
  assert.equal(result.awaitingAsyncCompletion.nextStepIndex, 1); assert.ok(!seen.includes('set_clip_style'))
  assert.match(result.message, /not completed/)
})
test('action plan refuses a project switch during checkpoint and between steps', async () => {
  for (const switchAt of ['create_project_checkpoint', 'set_clip_audio']) {
    const seen = [], original = { projectKey: '/original', session: 'one', timelineId: 'tl', timelineSessionId: 1, revision: 1 }
    let context = { ...original }
    const server = harness(async ({ action, payload }) => {
      seen.push(action)
      if (action === 'get_transport_state') {
        if (payload.expectedContext && payload.expectedContext.projectKey !== context.projectKey) throw new Error('project changed')
        return { context: { ...context } }
      }
      if (action === switchAt) context = { ...context, projectKey: '/other-project' }
      return { success: true }
    })
    const result = parse(await server.callTool('run_mcp_action_plan', { previewOnly: false, stopOnError: false, steps: [
      { tool: 'set_clip_audio', arguments: { clipId: 'a', gainDb: -2 } },
      { tool: 'set_clip_style', arguments: { clipId: 'a', opacity: 2 } },
    ] }))
    assert.equal(result.success, false); assert.ok(!seen.includes('set_clip_style'))
    if (switchAt === 'create_project_checkpoint') assert.ok(!seen.includes('set_clip_audio'))
  }
})
