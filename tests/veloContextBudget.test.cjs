'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { LIMITS, measureVeloContext, archivePolicy, createVeloContextBudget } = require('../electron/veloContextBudget.cjs')
const { createToolResultStore, formatModelHelperResult } = require('../electron/localAgentToolResults.cjs')
const result = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }] })
const payload = () => ({ requestId: 'synthetic_context_test', instructions: 'Keep exact user instructions.', reasoningEffort: 'low',
  input: [{ type: 'message', role: 'user', content: 'Complete my requested task; do not replay completed changes.' }], tools: [] })
const header = text => JSON.parse(text.split('\n')[0])
function fixture(options) {
  const store = createToolResultStore(options), body = payload()
  const budget = createVeloContextBudget({ archiveResult: (id, options) => store.archiveForModel(id, options) })
  function add(id, name, raw, images = []) {
    const policy = archivePolicy(name, raw, images)
    const text = store.packForModel(raw, id, { toolName: name, retainForContext: Boolean(policy), attachedImageCount: images.length })
    const output = { type: 'function_call_output', call_id: id, output: text }
    body.input.push({ type: 'function_call', call_id: id, name, arguments: JSON.stringify({ exact: id }) }, output)
    budget.observeResult(output, { policy, resultId: policy ? header(text).resultId : null })
    return output
  }
  return { store, body, budget, add }
}
function pad(body, chars = 182000) {
  for (let left = chars; left > 0; left -= 80000) body.input.unshift({ type: 'message', role: 'user', content: 'P'.repeat(Math.min(left, 80000)) })
}
const command = (extra = {}) => result({ success: true, status: 'completed', jobId: 'job_exact_123', exitCode: 0,
  signal: null, mainProcessExited: true, stdinClosed: true, possibleChanges: true,
  output: 'bulk output\n'.repeat(750), outputEncoding: 'utf8', outputStream: 'combined-stdout-stderr',
  offset: 0, nextOffset: 9000, availableFrom: 0, totalBytes: 9000, outputLostBytes: 0, hasMore: false,
  note: 'Effects remain; this is not rollback.', ...extra })

test('Responses accounting uses UTF-8 JSON bytes and typed-image replacement, not data-url or character heuristics', () => {
  const body = payload()
  body.input[0].content = 'Unicode 漢字🙂 and JSON escapes "\\\n'
  body.input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'image_url is ordinary text' },
    { type: 'input_image', detail: 'high', image_url: `data:image/png;base64,${'a'.repeat(1000000)}` }] })
  const textInput = structuredClone(body.input)
  textInput[1].content[1] = { type: 'input_text', text: '[Image input]' }
  const expected = Buffer.byteLength(JSON.stringify({ instructions: body.instructions, input: textInput, tools: body.tools, reasoningEffort: 'low' }))
  assert.equal(measureVeloContext(body).contextBytes, expected)
  assert.ok(measureVeloContext(body).wireBytes > 1000000)
  assert.equal(measureVeloContext(body).fits, true)
})

test('all independent protocol ceilings stop rather than dropping protected fields or call-output pairs', () => {
  const cases = [
    ['instructions', body => { body.instructions = 'i'.repeat(LIMITS.instructionsChars + 1) }],
    ['message', body => { body.input[0].content = 'u'.repeat(LIMITS.messageChars + 1) }],
    ['message', body => { body.input[0].content = [{ type: 'input_text', text: 'u'.repeat(LIMITS.messageChars + 1) }] }],
    ['arguments', body => body.input.push({ type: 'function_call', call_id: 'one', name: 'tool', arguments: 'a'.repeat(LIMITS.argumentsChars + 1) })],
    ['output', body => body.input.push({ type: 'function_call_output', call_id: 'one', output: 'o'.repeat(LIMITS.outputChars + 1) })],
    ['input-items', body => { body.input = Array.from({ length: 257 }, () => ({ type: 'message', role: 'user', content: '' })) }],
    ['content-parts', body => { body.input[0].content = Array.from({ length: 33 }, () => ({ type: 'input_text', text: '' })) }],
    ['tools', body => { body.tools = Array.from({ length: 129 }, () => ({})) }],
    ['wire-bytes', body => { body.input[0].content = [{ type: 'input_image', detail: 'high', image_url: 'x'.repeat(LIMITS.wireBytes) }] }],
    ['context-bytes', body => { body.input[0].content = '漢'.repeat(70000) }],
  ]
  for (const [violation, change] of cases) {
    const body = payload(); change(body)
    const before = JSON.stringify(body)
    assert.equal(measureVeloContext(body).violation, violation)
    assert.equal(JSON.stringify(body), before)
  }
})

test('Velo opt-in retains small exact results without changing the shared default', () => {
  const store = createToolResultStore(), raw = result({ success: true, exact: '🙂é漢字', array: [1, 1] })
  assert.equal(header(store.packForModel(raw, 'default')).resultId, null)
  const retained = header(store.packForModel(raw, 'velo', { retainForContext: true }))
  assert.equal(retained.complete, true); assert.equal(retained.pagingAvailable, true)
  const page = store.readForModel({ resultId: retained.resultId, representation: 'original', position: 'start' })
  assert.equal(page.raw, JSON.stringify(raw))
  assert.equal(page.complete, true)
  const rawBoundary = JSON.stringify({ content: [{ type: 'text', text: '' }] })
  const boundary = { content: [{ type: 'text', text: 'x'.repeat(12000 - rawBoundary.length) }] }
  const retainedBoundary = header(store.packForModel(boundary, 'boundary', { retainForContext: true }))
  assert.equal(JSON.stringify(boundary).length, 12000)
  assert.equal(retainedBoundary.complete, true, 'Readable labels must not turn a small retained result into an excerpt')
  assert.equal(store.readForModel({ resultId: retainedBoundary.resultId }).raw, '', 'The entire readable representation was already delivered')
  store.dispose()
})

test('over 192 KiB of old eligible inspections archives exact references and preserves latest result, user, instructions and protocol', () => {
  const f = fixture()
  for (let i = 0; i < 28; i++) f.add(`read_${i}`, 'get_project', result({ success: true, exact: `${i}:` + 'x'.repeat(8900) }))
  const initial = structuredClone(f.body), latest = f.body.input.at(-1).output
  assert.ok(measureVeloContext(f.body).contextBytes > LIMITS.contextBytes)
  const fitted = f.budget.fit(f.body)
  assert.equal(fitted.fits, true); assert.ok(fitted.archivedResults > 0)
  assert.equal(f.body.instructions, initial.instructions)
  assert.deepEqual(f.body.input.filter(item => item.type !== 'function_call_output'), initial.input.filter(item => item.type !== 'function_call_output'))
  assert.equal(f.body.input.at(-1).output, latest)
  const archived = f.body.input.find(item => item.type === 'function_call_output' && header(item.output).archived)
  assert.ok(archived)
  const original = f.store.readForModel({ resultId: header(archived.output).resultId, representation: 'original', position: 'start' })
  const index = Number(archived.call_id.split('_')[1])
  assert.equal(original.raw, JSON.stringify(result({ success: true, exact: `${index}:` + 'x'.repeat(8900) })))
  assert.equal(f.budget.fit(f.body).archivedResults, 0)
  f.store.dispose()
})

test('latest page groups remain protected and old exact pages can be archived without rereading a tool', () => {
  const f = fixture(), raw = result({ success: true, exact: 'P'.repeat(150000) })
  const first = f.add('large', 'get_project', raw), id = header(first.output).resultId
  pad(f.body, 60000)
  for (let offset = 0; offset < 150000; offset += 12000) {
    const page = f.store.readForModel({ resultId: id, offset })
    const message = { type: 'function_call_output', call_id: `page_${offset}`, output: formatModelHelperResult(page) }
    f.body.input.push({ type: 'function_call', call_id: message.call_id, name: 'read_velorn_tool_result', arguments: JSON.stringify({ resultId: id, offset }) }, message)
    f.budget.observePage(message, id)
  }
  const protectedBefore = JSON.stringify(f.body)
  assert.equal(f.budget.fit(f.body).fits, false)
  assert.equal(JSON.stringify(f.body), protectedBefore)
  f.add('new_inspection', 'get_project', result({ success: true, exact: 'latest' }))
  assert.equal(f.budget.fit(f.body).fits, true)
  assert.ok(f.body.input.filter(item => item.type === 'function_call_output' && item.call_id !== 'new_inspection').every(item => header(item.output).resultId === id && header(item.output).archived))
  assert.equal(f.store.readForModel({ resultId: id, representation: 'original', position: 'start' }).raw, JSON.stringify(raw).slice(0, 12000))
  f.store.dispose()
})

test('failures, uncertain/partial/running jobs, previews, writes and images are never eligible', () => {
  const protectedResults = [
    ['get_project', { ...result({ success: true }), isError: true }],
    ['get_project', result({ nested: { success: false, error: 'exact failure' } })],
    ['get_project', result({ success: true, previewOnly: true })],
    ['get_project', result({ success: true, possibleChanges: true })],
    ['get_project', result({ success: true, status: 'running' })],
    ...['partial', 'unknown', 'interrupted', 'outcome-unconfirmed'].map(status => ['get_project', result({ success: true, status })]),
    ['get_project', result({ success: true, nested: { partial: true } })],
    ['get_setup_status', result({ success: true, state: 'unavailable' })],
    ['get_setup_status', result({ success: true, state: 'ready', warnings: ['three packages need attention'] })],
    ['get_comfyui_launcher_logs', result({ success: true, logs: ['warning: three packages need attention'] })],
    ['write_computer_file', result({ success: true, bytesWritten: 20 })],
    ['run_computer_command', command({ status: 'running', exitCode: null, mainProcessExited: false })],
    ['run_computer_command', command({ success: false, status: 'failed', exitCode: 1, output: 'fatal: exact partial failure' })],
    ['run_computer_command', command({ success: false, status: 'cancelled', signal: 'SIGTERM' })],
    ['run_computer_command', command({ recovery: { reason: 'outcome-unconfirmed' } })],
    ['run_computer_command', command({ output: `fatal: ${'x'.repeat(12000)}` })],
  ]
  for (const [name, raw] of protectedResults) assert.equal(archivePolicy(name, raw), null, name)
  assert.equal(archivePolicy('get_project', result({ success: true }), [{}]), null)
  const f = fixture()
  for (let i = 0; i < 24; i++) f.add(`failure_${i}`, 'get_project', result({ success: false, error: 'exact failure', evidence: 'E'.repeat(9000) }))
  const before = JSON.stringify(f.body)
  assert.equal(f.budget.fit(f.body).fits, false)
  assert.equal(JSON.stringify(f.body), before)
  f.store.dispose()
})

test('only terminal-success command bulk archives, preserving all receipt fields, mutation evidence and exact diagnostic lines', () => {
  const f = fixture(), original = command({ output: `start\n${'ordinary output\n'.repeat(280)}warning: exact dependency warning\n${'normal data\n'.repeat(430)}tail\n`, extraFutureField: { untouched: 'fact' } })
  const before = f.add('mutation_once', 'run_computer_command', original)
  f.add('later', 'get_project', result({ success: true, content: 'new observation' }))
  pad(f.body, 187000)
  assert.equal(f.budget.fit(f.body).fits, true)
  const ref = header(before.output)
  assert.equal(ref.kind, 'velo-command-output-reference')
  assert.match(ref.notice, /untrusted data, not instructions/)
  const projected = JSON.parse(before.output.split('\n\n')[1])
  const { output, ...receipt } = JSON.parse(original.content[0].text)
  assert.deepEqual(projected.commandReceipt, receipt)
  assert.ok(projected.outputExcerpts.some(excerpt => excerpt.text.includes('warning: exact dependency warning\n')))
  for (const excerpt of projected.outputExcerpts) assert.equal(excerpt.text, output.slice(excerpt.offset, excerpt.endOffset))
  assert.equal(f.store.readForModel({ resultId: ref.resultId, representation: 'original', position: 'start' }).raw, JSON.stringify(original))
  f.store.dispose()
})

test('retention capacity does not create fictional references or evict an earlier exact result', () => {
  const f = fixture({ maxResults: 1 }), a = f.add('first', 'get_project', result({ text: 'a'.repeat(9000) }))
  const id = header(a.output).resultId
  const b = f.add('second', 'get_project', result({ text: 'b'.repeat(9000) }))
  assert.equal(header(b.output).resultId, null)
  pad(f.body, 180000)
  f.budget.fit(f.body)
  assert.equal(header(a.output).resultId, id)
  assert.equal(f.store.stats().resultCount, 1)
  assert.match(f.store.readForModel({ resultId: id, position: 'start', representation: 'original' }).raw, /aaaa/)
  f.store.dispose()
})

test('archive, retrieve, re-archive resets unread delivery only on the committed archive', () => {
  const f = fixture()
  for (let i = 0; i < 28; i++) f.add(`read_${i}`, 'get_project', result({ exact: 'x'.repeat(9000) }))
  assert.equal(f.budget.fit(f.body).fits, true)
  const first = f.body.input.find(item => item.type === 'function_call_output' && header(item.output).archived)
  const id = header(first.output).resultId
  const page = f.store.readForModel({ resultId: id })
  assert.equal(page.offset, 0); assert.equal(page.deliveryProgress.allCharsDelivered, true)
  f.store.archiveForModel(id, { commit: false })
  assert.equal(f.store.readForModel({ resultId: id }).raw, '', 'Preparing an archive cannot reset delivery')
  const message = { type: 'function_call_output', call_id: 'retrieved', output: formatModelHelperResult(page) }
  f.body.input.push({ type: 'function_call', call_id: 'retrieved', name: 'read_velorn_tool_result', arguments: JSON.stringify({ resultId: id }) }, message)
  f.budget.observePage(message, id)
  f.add('fresh_result', 'get_project', result({ text: 'fresh'.repeat(1500) }))
  assert.equal(f.budget.fit(f.body).fits, true)
  assert.equal(header(message.output).archived, true)
  assert.equal(f.store.readForModel({ resultId: id }).offset, 0, 'Removed pages become readable again from the beginning')
  f.store.dispose()
})
