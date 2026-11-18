import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'

// Execute the renderer service itself with synthetic native/ComfyUI boundaries.
// There is no real app, project, model, filesystem write or generation request.
const source = fs.readFileSync(new URL('../src/services/mcpWorkflowOpening.js', import.meta.url), 'utf8')
const moduleBody = source.replace(/^import[^\n]+\n/gm, '').replace(/^export /gm, '')
const plain = value => JSON.parse(JSON.stringify(value))
const ui = () => ({ nodes: [{ id: 1, type: 'PrimitiveStringMultiline' }], links: [] })
const apiGraph = () => ({ 1: { class_type: 'PrimitiveStringMultiline', inputs: { value: 'synthetic prompt' } } })
const savedUi = () => ({ success: true, title: 'Saved UI recipe', format: 'ui', uiWorkflow: ui() })
const savedApi = () => ({ success: true, title: 'Saved API recipe', format: 'api', workflow: apiGraph() })

function harness({ saved = savedUi(), reader, loader, missingBridge = false } = {}) {
  const calls = { reads: [], opens: [] }
  const state = { exportBusy: false, projectKey: null, revision: 1 }
  const current = () => ({ session: 'synthetic-session', projectKey: state.projectKey, revision: state.revision })
  const bridge = {
    readSavedWorkflow: async payload => {
      calls.reads.push(plain(payload))
      return reader ? reader(payload, state) : saved
    },
  }
  const open = format => async (graph, options) => {
    calls.opens.push({ format, graph, options })
    return loader ? loader(graph, options, state) : { success: true }
  }
  const context = vm.createContext({
    window: { electronAPI: missingBridge ? {} : bridge },
    isExportBusy: () => state.exportBusy,
    captureMcpContext: current,
    assertMcpContext: expected => {
      if (expected !== undefined && JSON.stringify(expected) !== JSON.stringify(current())) throw new Error('The project or timeline changed after preview.')
    },
    openUiWorkflowInComfyUi: open('ui'),
    openApiWorkflowInComfyUi: open('api'),
  })
  const handler = vm.runInContext(`${moduleBody}; handleOpenComfyUiWorkflow`, context)
  return { handler, calls, state, current }
}

for (const [format, workflowId, saved] of [
  ['ui', 'my-workflow:synthetic', savedUi],
  ['api', 'tpl-mcp-synthetic', savedApi],
]) {
  test(`${format} preview inspects the saved graph without changing tabs or starting generation`, async () => {
    const { handler, calls, current } = harness({ saved: saved() })
    const result = await handler({ workflowId })
    assert.equal(result.success, true)
    assert.equal(result.previewOnly, true)
    assert.equal(result.opened, false)
    assert.equal(result.applied, false)
    assert.equal(result.generationSubmitted, false)
    assert.equal(result.workflowId, workflowId)
    assert.equal(result.title, saved().title)
    assert.equal(result.format, format)
    assert.equal(result.nodeCount, 1)
    assert.equal(result.target, 'comfyui')
    assert.equal(result.plan.replacesActiveGraph, true)
    assert.match(result.message, /unsaved graph changes/)
    assert.deepEqual(plain(result.suggestedApplyPayload), { workflowId, previewOnly: false, expectedContext: current() })
    assert.deepEqual(calls.reads, [{ workflowId }])
    assert.deepEqual(calls.opens, [])
    assert.equal(Object.hasOwn(result, 'workflow'), false)
    assert.equal(Object.hasOwn(result, 'uiWorkflow'), false)
  })

  test(`${format} apply opens through the existing loader and confirms only its successful result`, async () => {
    const { handler, calls, current } = harness({ saved: saved() })
    const result = await handler({ workflowId, previewOnly: false })
    assert.equal(result.success, true)
    assert.equal(result.previewOnly, false)
    assert.equal(result.opened, true)
    assert.equal(result.applied, true)
    assert.equal(result.generationSubmitted, false)
    assert.equal(result.workflowId, workflowId)
    assert.equal(result.title, saved().title)
    assert.equal(result.format, format)
    assert.equal(result.nodeCount, 1)
    assert.deepEqual(calls.reads, [{ workflowId }])
    assert.equal(calls.opens.length, 1)
    assert.equal(calls.opens[0].format, format)
    assert.deepEqual(plain(calls.opens[0].graph), saved().uiWorkflow || saved().workflow)
    assert.equal(calls.opens[0].options.label, saved().title)
    assert.equal(typeof calls.opens[0].options.assertCurrent, 'function')
    assert.deepEqual(calls.opens[0].options.expectedContext, current())
    assert.match(result.message, /No generation was started/)
  })
}

test('apply reads the saved workflow again, without requiring a second renderer confirmation', async () => {
  let count = 0
  const { handler, calls } = harness({ reader: async () => ({ ...savedUi(), title: `Read ${++count}`, uiWorkflow: { ...ui(), nodes: [...ui().nodes, ...Array(count).fill({ id: 2, type: 'PreviewImage' })] } }) })
  const preview = await handler({ workflowId: 'my-workflow:synthetic' })
  const applied = await handler(preview.suggestedApplyPayload)
  assert.equal(count, 2)
  assert.equal(applied.title, 'Read 2')
  assert.equal(applied.nodeCount, 3)
  assert.equal(calls.opens.length, 1)
  assert.equal(calls.opens[0].graph.nodes.length, 3)
})

test('missing workflow IDs and desktop bridge fail before reading or opening', async () => {
  const normal = harness()
  for (const payload of [{}, { workflowId: '  ' }, { workflowId: 123 }]) {
    await assert.rejects(normal.handler(payload), /workflowId is required/)
  }
  assert.deepEqual(normal.calls, { reads: [], opens: [] })
  const missing = harness({ missingBridge: true })
  await assert.rejects(missing.handler({ workflowId: 'my-workflow:synthetic' }), /updated desktop bridge/)
  assert.deepEqual(missing.calls, { reads: [], opens: [] })
})

test('native missing-workflow and read failures propagate with no opening', async () => {
  for (const reader of [
    async () => ({ success: false, error: 'Saved workflow is missing.' }),
    async () => { throw new Error('Synthetic storage unavailable') },
    async () => undefined,
  ]) {
    const { handler, calls } = harness({ reader })
    await assert.rejects(handler({ workflowId: 'tpl-mcp-missing', previewOnly: false }), /missing|storage unavailable|Could not read/)
    assert.equal(calls.reads.length, 1)
    assert.equal(calls.opens.length, 0)
  }
})

test('malformed saved graph envelopes do not open a tab', async () => {
  for (const saved of [
    { success: true, format: 'ui', uiWorkflow: {} },
    { success: true, format: 'api', workflow: [] },
    { success: true, format: 'unknown', workflow: apiGraph() },
  ]) {
    const { handler, calls } = harness({ saved })
    await assert.rejects(handler({ workflowId: 'my-workflow:synthetic', previewOnly: false }), /editable ComfyUI graph/)
    assert.equal(calls.opens.length, 0)
  }
})

test('loader failures or absent acknowledgements never claim opened or applied', async () => {
  for (const format of ['ui', 'api']) {
    for (const loader of [
      async () => ({ success: false, error: 'Synthetic iframe load failed' }),
      async () => undefined,
      async () => ({ success: 'true' }),
      async () => { throw new Error('Synthetic connection lost') },
    ]) {
      const { handler, calls } = harness({ saved: format === 'ui' ? savedUi() : savedApi(), loader })
      await assert.rejects(handler({ workflowId: 'tpl-mcp-synthetic', previewOnly: false }), /iframe load failed|Could not load|connection lost/)
      assert.equal(calls.opens.length, 1)
    }
  }
})

test('existing stale-context and export checks still apply across asynchronous reads', async () => {
  const stale = harness()
  await assert.rejects(stale.handler({ workflowId: 'tpl-mcp-synthetic', expectedContext: { ...stale.current(), revision: 0 } }), /changed after preview/)
  assert.deepEqual(stale.calls, { reads: [], opens: [] })
  for (const change of [state => { state.exportBusy = true }, state => { state.projectKey = 'another-project' }]) {
    const { handler, calls } = harness({ reader: async (_, state) => { change(state); return savedUi() } })
    await assert.rejects(handler({ workflowId: 'my-workflow:synthetic', previewOnly: false }), /export|changed after preview/)
    assert.equal(calls.opens.length, 0)
  }
})

test('existing loaders receive a guard that detects changes before the actual native handoff', async () => {
  const { handler } = harness({ loader: async (_, options, state) => {
    state.revision += 1
    options.assertCurrent()
    return { success: true }
  } })
  await assert.rejects(handler({ workflowId: 'my-workflow:synthetic', previewOnly: false }), /changed after preview/)
})

test('public renderer action dispatch is wired to the new workflow opening handler', () => {
  const actions = fs.readFileSync(new URL('../src/services/mcpActions.js', import.meta.url), 'utf8')
  assert.match(actions, /import \{ handleOpenComfyUiWorkflow \} from '\.\/mcpWorkflowOpening'/)
  assert.match(actions, /open_comfyui_workflow: handleOpenComfyUiWorkflow/)
})
