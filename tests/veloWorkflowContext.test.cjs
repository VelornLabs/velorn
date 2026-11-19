'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { pathToFileURL } = require('node:url')
const { createComfyStudioMcpServer } = require('../electron/mcpServer.js')
const { createManagedApiWorkflowStore, loadManagedWorkflowCatalog, readBounded } = require('../electron/managedApiWorkflows.cjs')
const { createSavedWorkflowLibrary } = require('../electron/savedWorkflowLibrary.cjs')
const { createGenerationRuns } = require('../electron/generationRuns.cjs')
const { createToolResultStore, formatModelHelperResult } = require('../electron/localAgentToolResults.cjs')
const { archivePolicy, createVeloContextBudget, measureVeloContext, LIMITS } = require('../electron/veloContextBudget.cjs')
const wrap = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }] })
const unpack = result => JSON.parse(result.content[0].text)
const header = value => JSON.parse(value.split('\n')[0])
const projection = value => JSON.parse(value.split('\n\n')[1])

async function nativeFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'velo-workflow-context-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const graph = { '1': { class_type: 'CLIPTextEncode', inputs: { text: 'Synthetic prompt 漢字🙂 '.repeat(350) }, _meta: { title: 'Synthetic prompt' } } }
  for (let index = 2; index < 42; index++) graph[String(index)] = { class_type: 'KSampler', inputs: { positive: [String(index - 1), 0], seed: index, steps: 8, cfg: 1 } }
  graph['42'] = { class_type: 'SaveVideo', inputs: { video: ['41', 0], filename_prefix: 'video/synthetic' } }
  const available = async ({ nodeClasses }) => ({ validation: { ok: true, available: nodeClasses, missing: [] }, connection: { ok: true } })
  let savedActions = 0
  const store = createManagedApiWorkflowStore({ getUserData: () => root, validateNodes: available })
  const server = createComfyStudioMcpServer({ importManagedApiWorkflow: args => store.importWorkflow(args),
    performAction: async () => { savedActions++; return { success: true } } })
  const preview = await server.importComfyUiWorkflowTool({ workflowJson: graph, name: 'synthetic-context', previewOnly: true })
  const applied = await server.importComfyUiWorkflowTool(unpack(preview).suggestedApplyCall.arguments)
  assert.equal(savedActions, 1)
  const catalog = await loadManagedWorkflowCatalog(root)
  const source = await fs.readFile(path.join(__dirname, '../electron/main.js'), 'utf8')
  const start = source.indexOf('async function inspectComfyStudioWorkflowInternal(')
  const end = source.indexOf('\nfunction summarizeComfyLauncherLogIssues', start)
  assert.ok(start > 0 && end > start)
  const body = source.slice(start, end).replace("import('./workflowApiGraph.mjs')", `import(${JSON.stringify(pathToFileURL(path.join(__dirname, '../electron/workflowApiGraph.mjs')).href)})`)
  const inspect = new Function('resolveMcpWorkflowReference', 'readBoundedWorkflowFile', 'fs', 'crypto', 'collectWorkflowClassTypes', 'loadMcpNodeHintManifest', 'validateComfyUINodesInternal', 'buildWorkflowNodeHints', 'savedWorkflowLibrary', `${body}; return inspectComfyStudioWorkflowInternal`)(
    async () => ({ success: true, workflow: catalog.workflows[0] }), readBounded, fs, crypto,
    value => new Set(Object.values(value).map(node => node.class_type)), async () => ({ success: true }), available, () => [],
    createSavedWorkflowLibrary({ getUserData: () => root }))
  const inspection = wrap(await inspect({ includeGraph: true }))
  const context = { session: 'synthetic', projectKey: '/synthetic/project', timelineId: 'timeline' }
  const runs = createGenerationRuns({ storageDir: path.join(root, 'runs'), getEndpoint: async () => 'http://127.0.0.1:8188',
    getContext: async () => context, fetchImpl: async () => { throw new Error('No network is allowed by this fixture') } })
  t.after(() => runs.dispose())
  const recorded = await runs.beforeSubmit({ requestId: 'synthetic_context_request', clientId: 'synthetic_client', workflow: graph,
    fingerprint: crypto.createHash('sha256').update(JSON.stringify(graph)).digest('hex'), endpoint: 'http://127.0.0.1:8188',
    context: JSON.stringify([context.session, context.projectKey, context.timelineId]), assessment: { risk: 'unknown' } })
  const recipe = wrap(await runs.recipe({ runId: recorded.runId }))
  assert.equal(unpack(recipe).success, true)
  return { preview, applied, inspection, recipe, savedActions: () => savedActions }
}
function assertExactReceipt(raw, projected) {
  const data = unpack(raw), receipt = structuredClone(projected.workflowReceipt)
  for (const fieldPath of projected.retainedFields) {
    let original = data, retained = receipt
    for (const key of fieldPath.slice(0, -1)) { original = original[key]; retained = retained[key] }
    const key = fieldPath.at(-1)
    assert.deepEqual(retained[key], { kind: 'retained-workflow-data', fieldPath, exactChars: JSON.stringify(original[key]).length })
    retained[key] = original[key]
  }
  assert.deepEqual(receipt, data, 'Every field outside explicitly retained immutable data remains exact')
  const { content, ...envelope } = raw, { text, ...blockFields } = content[0]
  assert.deepEqual(projected.originalMcpEnvelope, envelope)
  assert.deepEqual(projected.originalContentBlockFields, blockFields)
}
function contextFixture() {
  const store = createToolResultStore(), payload = { requestId: 'synthetic_context', reasoningEffort: 'low',
    instructions: 'Preserve warnings, approvals and completed effects.', tools: [],
    input: [{ type: 'message', role: 'user', content: 'Use the reviewed workflow without repeating completed work.' }] }
  const budget = createVeloContextBudget({ archiveResult: (id, options) => store.archiveForModel(id, options) })
  const add = (name, raw, callId, args = {}) => {
    const policy = archivePolicy(name, raw)
    const output = { type: 'function_call_output', call_id: callId,
      output: store.packForModel(raw, callId, { toolName: name, retainForContext: Boolean(policy) }) }
    payload.input.push({ type: 'function_call', call_id: callId, name, arguments: JSON.stringify(args) }, output)
    budget.observeResult(output, { policy, resultId: policy ? header(output.output).resultId : null })
    return output
  }
  const pageAll = output => {
    const id = header(output.output).resultId
    for (let index = 0; index < 100; index++) {
      const page = store.readForModel({ resultId: id })
      if (!page.raw) break
      const callId = `${output.call_id}_page_${index}`, value = { type: 'function_call_output', call_id: callId, output: formatModelHelperResult(page) }
      payload.input.push({ type: 'function_call', call_id: callId, name: 'read_velorn_tool_result', arguments: JSON.stringify({ resultId: id }) }, value)
      budget.observePage(value, id)
      if (page.deliveryProgress.allCharsDelivered) break
    }
  }
  return { store, payload, budget, add, pageAll }
}
function overflow(payload, excess = 4000) {
  let padding = LIMITS.contextBytes + excess - measureVeloContext(payload).contextBytes
  while (padding > 0) { const size = Math.min(padding, 80000); payload.input.unshift({ type: 'message', role: 'user', content: 'P'.repeat(size) }); padding -= size }
}
function exactOriginal(store, id) {
  let text = '', offset = 0
  for (let index = 0; index < 1000; index++) {
    const page = store.readForModel({ resultId: id, representation: 'original', offset })
    text += page.raw
    if (page.nextOffset === null || page.endOffset >= page.totalChars) return text
    assert.ok(page.nextOffset > offset)
    offset = page.nextOffset
  }
  assert.fail('Exact retained result did not terminate')
}

test('actual native import/inspection/run recipe preserve every non-bulk receipt field', async t => {
  const f = await nativeFixture(t)
  for (const [name, raw] of [['import_comfyui_workflow', f.preview], ['import_comfyui_workflow', f.applied],
    ['inspect_velorn_workflow', f.inspection], ['inspect_comfyui_run', f.recipe]]) {
    const before = JSON.stringify(raw), policy = archivePolicy(name, raw)
    assert.equal(policy?.kind, 'workflow-data', name)
    const projected = JSON.parse(policy.body)
    assertExactReceipt(raw, projected)
    assert.equal(JSON.stringify(raw), before)
    if (name === 'import_comfyui_workflow') {
      assert.deepEqual(projected.workflowReceipt.plan.warnings, unpack(raw).plan.warnings)
      assert.equal(projected.workflowReceipt.previewOnly, unpack(raw).previewOnly)
      assert.equal(projected.workflowReceipt.plan.sourceFingerprint, unpack(raw).plan.sourceFingerprint)
      assert.equal(projected.workflowReceipt.plan.targetFingerprint, unpack(raw).plan.targetFingerprint)
    }
    if (name === 'inspect_comfyui_run') assert.equal(projected.workflowReceipt.cannotExactReplay, true)
  }
  assert.equal(f.savedActions(), 1, 'Native import was not repeated to retrieve any result')
})

test('192 KiB fitting protects latest workflow pages, then archives exact data without replay', async t => {
  const native = await nativeFixture(t), f = contextFixture()
  t.after(() => f.store.dispose())
  const first = f.add('inspect_velorn_workflow', native.inspection, 'inspect_once', { workflowId: unpack(native.inspection).workflow.id, includeGraph: true })
  f.pageAll(first)
  overflow(f.payload)
  const protectedBefore = JSON.stringify(f.payload)
  assert.equal(f.budget.fit(f.payload).fits, false, 'The latest graph and all its pages stay in context')
  assert.equal(JSON.stringify(f.payload), protectedBefore)
  const running = f.add('get_comfyui_runs', wrap({ success: true, runs: [{ id: 'exact_run', status: 'running', error: null, warning: 'Do not submit again' }] }), 'status_once')
  const originalRunning = running.output, calls = structuredClone(f.payload.input.filter(item => item.type !== 'function_call_output'))
  const fitted = f.budget.fit(f.payload)
  assert.equal(fitted.fits, true)
  assert.equal(fitted.archivedResults, 1)
  assert.equal(running.output, originalRunning)
  assert.deepEqual(f.payload.input.filter(item => item.type !== 'function_call_output'), calls)
  for (const item of f.payload.input.filter(item => item.type === 'function_call_output' && item !== running)) {
    assert.equal(header(item.output).kind, 'velo-workflow-data-reference')
    assertExactReceipt(native.inspection, projection(item.output))
  }
  assert.equal(exactOriginal(f.store, header(first.output).resultId), JSON.stringify(native.inspection))
  assert.equal(native.savedActions(), 1)
})

test('unknown nested metadata, failures, running receipts and images are never silently projected away', async t => {
  const native = await nativeFixture(t), original = unpack(native.inspection)
  const guarded = structuredClone(original)
  guarded.workflowJson['1']._meta.futureWarning = { error: 'Preserve nested warning' }
  guarded.bindings.parameters[0].futureState = { status: 'uncertain' }
  guarded.queueInputs.namedInputs[0].futureReceipt = { partial: true }
  assert.equal(archivePolicy('inspect_velorn_workflow', wrap(guarded)), null)
  const partial = structuredClone(original)
  partial.workflowJson['1']._meta.warning = 'Exact graph warning must stay'
  partial.validation = { ok: false, warnings: ['Exact validation warning'], error: { code: 'MISSING_MODEL' } }
  partial.futureNativeReceipt = { status: 'uncertain', fingerprint: 'native_future_identity' }
  const projected = JSON.parse(archivePolicy('inspect_velorn_workflow', wrap(partial)).body)
  assert.ok(!projected.retainedFields.some(fieldPath => fieldPath[0] === 'workflowJson'))
  assertExactReceipt(wrap(partial), projected)
  assert.deepEqual(projected.workflowReceipt.workflowJson, partial.workflowJson)
  assert.equal(archivePolicy('inspect_velorn_workflow', { ...native.inspection, isError: true }), null)
  assert.equal(archivePolicy('inspect_velorn_workflow', wrap({ ...original, success: false })), null)
  assert.equal(archivePolicy('inspect_velorn_workflow', native.inspection, [{}]), null)
  for (const text of [
    native.inspection.content[0].text.replace('"success":true', '"success":false,"success":true'),
    native.inspection.content[0].text.replace('"success":true', '"success":true,"futureNumber":9007199254740993'),
    native.inspection.content[0].text.replace('"success":true', '"success":true,"futureNumber":-0'),
  ]) assert.equal(archivePolicy('inspect_velorn_workflow', { content: [{ type: 'text', text }] }), null,
    'Non-lossless JSON must remain verbatim, not be normalized into a partial receipt')
  for (const name of ['get_comfyui_runs', 'queue_comfyui_workflow', 'validate_comfyui_workflow', 'get_comfyui_launcher_logs']) {
    assert.equal(archivePolicy(name, wrap({ ...original, status: 'running', possibleChanges: true })), null)
  }
})

test('captured native workflow context fits without changing args, receipts or rerunning tools', {
  skip: !process.env.VELORN_TEST_VELO_TRACE && 'Private live trace is optional and never bundled',
}, async t => {
  const trace = JSON.parse(await fs.readFile(process.env.VELORN_TEST_VELO_TRACE, 'utf8'))
  let validateRelay
  if (process.env.VELORN_TEST_RELAY_SOURCE) {
    const relay = await import(pathToFileURL(path.join(process.env.VELORN_TEST_RELAY_SOURCE, 'fundedLuna.mjs')).href)
    assert.equal(relay.FUNDED_LUNA_LIMITS.contextBytes, LIMITS.contextBytes)
    validateRelay = payload => relay.validateFundedLunaRequest({ computerId: 'synthetic_workflow_context', ...payload })
  }
  const records = new Map(), payloads = trace.filter(entry => entry.payload)
  for (let index = 0; index < trace.length; index++) {
    const entry = trace[index]
    if (!entry.result) continue
    const next = trace.slice(index + 1).find(item => item.payload)?.payload
    const call = next?.input.filter(item => item.type === 'function_call').at(-1)
    if (!call) continue
    const name = call.name === 'call_velorn_tool' ? JSON.parse(call.arguments).name : call.name
    if (name === entry.name) records.set(call.call_id, entry)
  }
  let checked = 0
  for (const selected of payloads.filter((entry, index) => index === payloads.length - 1 || payloads[index + 1].round === 0)) {
    const f = contextFixture(), body = structuredClone(selected.payload), ids = new Map(), rawById = new Map()
    t.after(() => f.store.dispose())
    for (const item of body.input) {
      if (item.type !== 'function_call_output') continue
      const record = records.get(item.call_id)
      if (record) {
        const candidatePolicy = archivePolicy(record.name, record.result)
        // Prove the new workflow projection itself can recover this trace;
        // existing file/command archiving must not mask a regression here.
        const policy = candidatePolicy?.kind === 'workflow-data' ? candidatePolicy : null
        let id = null
        if (policy) {
          const packed = f.store.packForModel(record.result, item.call_id, { toolName: record.name, retainForContext: true })
          id = header(packed).resultId
          rawById.set(id, record.result)
          const originalId = header(item.output).resultId
          if (originalId) ids.set(originalId, id)
        }
        f.budget.observeResult(item, { policy, resultId: id })
      } else {
        let value
        try { value = header(item.output) } catch { continue }
        if (value.resultId && ids.has(value.resultId)) f.budget.observePage(item, ids.get(value.resultId))
      }
    }
    if (!rawById.size) continue
    overflow(body, 1500)
    const unchanged = structuredClone(body.input.filter(item => item.type !== 'function_call_output'))
    const before = measureVeloContext(body)
    assert.equal(before.violation, 'context-bytes')
    if (validateRelay) assert.throws(() => validateRelay(body), { code: 'invalid_request' })
    const fitted = f.budget.fit(body)
    assert.equal(fitted.fits, true)
    if (validateRelay) assert.doesNotThrow(() => validateRelay(body))
    assert.ok(fitted.archivedResults > 0)
    assert.deepEqual(body.input.filter(item => item.type !== 'function_call_output'), unchanged)
    let references = 0
    for (const item of body.input.filter(item => item.type === 'function_call_output')) {
      let value
      try { value = header(item.output) } catch { continue }
      if (value.kind !== 'velo-workflow-data-reference') continue
      const original = rawById.get(value.resultId)
      assertExactReceipt(original, projection(item.output))
      assert.equal(exactOriginal(f.store, value.resultId), JSON.stringify(original))
      references++
    }
    assert.ok(references > 0)
    t.diagnostic(`Captured turn ${++checked}: ${before.contextBytes} -> ${fitted.contextBytes} bytes; ${fitted.archivedResults} archived results; no tool execution`)
  }
  assert.ok(checked > 0)
})
