'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { LOCAL_CONTEXT_BYTES, contextBytes, isArchivableInspection, createLocalContextBudget } = require('../electron/localAgentContextBudget.cjs')

const toolMessage = (id, content) => ({ role: 'tool', tool_call_id: id, content })
const assistantCalls = (...ids) => ({ role: 'assistant', content: null,
  tool_calls: ids.map(id => ({ id, type: 'function', function: { name: 'get_timeline', arguments: '{}' } })) })
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })
function fixture(limitBytes = 1800) {
  const preparations = [], commits = []
  const archiveResult = (resultId, { commit }) => {
    ;(commit ? commits : preparations).push(resultId)
    return { resultId, content: JSON.stringify({ kind: 'local-tool-result-reference', resultId,
      complete: false, needsReview: true, notice: 'Retained historical result; read it before relying on omitted data.' }) }
  }
  return { budget: createLocalContextBudget({ archiveResult, limitBytes }), preparations, commits }
}
function assertProtocolPairs(messages) {
  let pending = new Set()
  for (const message of messages) {
    if (message.role === 'assistant' && message.tool_calls?.length) {
      assert.equal(pending.size, 0, 'No unresolved earlier tool-call group may be bypassed')
      pending = new Set(message.tool_calls.map(call => call.id))
    } else if (message.role === 'tool') {
      assert.equal(pending.delete(message.tool_call_id), true, 'Every result must match an outstanding call exactly once')
    } else assert.equal(pending.size, 0, 'No new message may split an incomplete tool group')
  }
  assert.equal(pending.size, 0)
}

test('context compaction replaces only old inspection bodies and their pages, preserving calls and current authority', () => {
  const f = fixture(3200)
  const oldRead = toolMessage('old-read', 'A'.repeat(1900))
  const oldPage = toolMessage('old-page', 'B'.repeat(1900))
  const latestRead = toolMessage('latest-read', 'CURRENT_GUARD: revision=21')
  const preview = toolMessage('preview', JSON.stringify({ previewOnly: true, previewToken: 'one-use-token', expectedContext: { revision: 21 } }))
  const failure = toolMessage('denied', JSON.stringify({ isError: true, error: 'Approval denied. Nothing applied.' }))
  const payload = { messages: [{ role: 'system', content: 'Trusted host approval remains mandatory.' },
    { role: 'user', content: 'CURRENT USER REQUEST AND ATTACHED DOCUMENT MUST STAY EXACT.' },
    assistantCalls('old-read'), oldRead, assistantCalls('old-page'), oldPage,
    assistantCalls('preview', 'denied'), preview, failure, assistantCalls('latest-read'), latestRead] }
  const original = structuredClone(payload)
  f.budget.observeResult(oldRead, { resultId: 'old', readOnly: true })
  f.budget.observePage(oldPage, 'old')
  f.budget.observeResult(preview, { resultId: 'preview', readOnly: false })
  f.budget.observeResult(failure, { resultId: 'denied', readOnly: false })
  f.budget.observeResult(latestRead, { resultId: 'latest', readOnly: true })
  const measured = f.budget.fit(payload)
  assert.equal(measured.fits, true)
  assert.equal(measured.archivedResults, 1)
  assert.deepEqual(f.commits, ['old'])
  assert.equal(oldRead.content, oldPage.content)
  for (const [index, message] of payload.messages.entries()) {
    if (message === oldRead || message === oldPage) assert.equal(message.tool_call_id, original.messages[index].tool_call_id)
    else assert.deepEqual(message, original.messages[index])
  }
  assertProtocolPairs(payload.messages)
  assert.equal(f.budget.fit(payload).archivedResults, 0, 'No duplicate bookkeeping reset or automatic replay')
})

test('a protected current request or newest inspection can exceed the compaction target without truncation', () => {
  const f = fixture(800)
  const newest = toolMessage('latest', 'L'.repeat(1200))
  const payload = { messages: [{ role: 'system', content: 'Never change a project without approval.' },
    { role: 'user', content: 'U'.repeat(1400) }, assistantCalls('latest'), newest] }
  const original = structuredClone(payload)
  f.budget.observeResult(newest, { resultId: 'latest', readOnly: true })
  assert.equal(f.budget.fit(payload).fits, false)
  assert.deepEqual(payload, original)
  assert.deepEqual(f.commits, [])
})

test('ordinary under-budget requests retain all original payloads and delivery bookkeeping', () => {
  const f = fixture(2000), old = toolMessage('old', 'Earlier result'), latest = toolMessage('latest', 'New result')
  const payload = { messages: [assistantCalls('old'), old, assistantCalls('latest'), latest] }
  f.budget.observeResult(old, { resultId: 'old', readOnly: true })
  f.budget.observeResult(latest, { resultId: 'latest', readOnly: true })
  const before = structuredClone(payload)
  assert.equal(f.budget.fit(payload).fits, true)
  assert.deepEqual(payload, before)
  assert.deepEqual(f.preparations, [])
})

test('a newer inline inspection supersedes an older large result, but revisiting it protects its newly read page', () => {
  const f = fixture(700), old = toolMessage('old', 'A'.repeat(1000)), latest = toolMessage('latest', 'Small current timeline')
  const payload = { messages: [assistantCalls('old'), old, assistantCalls('latest'), latest] }
  f.budget.observeResult(old, { resultId: 'old', readOnly: true })
  f.budget.observeResult(latest, { readOnly: true })
  assert.equal(f.budget.fit(payload).fits, true)
  assert.deepEqual(f.commits, ['old'])
  const page = toolMessage('reread', 'Exact original content revisited.'.repeat(40))
  payload.messages.push(assistantCalls('reread'), page)
  f.budget.observePage(page, 'old')
  const before = page.content
  assert.equal(f.budget.fit(payload).fits, false)
  assert.equal(page.content, before)
  assert.deepEqual(f.commits, ['old'], 'A newly revisited latest result may not be immediately archived again')
  assertProtocolPairs(payload.messages)
})

test('unavailable or larger references never replace existing data or reset result delivery', () => {
  for (const prepare of [() => null, () => ({ content: 'L'.repeat(5000) })]) {
    const commits = [], budget = createLocalContextBudget({ limitBytes: 500,
      archiveResult: (id, { commit }) => { if (commit) commits.push(id); return prepare() } })
    const old = toolMessage('old', 'A'.repeat(600)), latest = toolMessage('new', 'Latest')
    const payload = { messages: [assistantCalls('old'), old, assistantCalls('new'), latest] }
    budget.observeResult(old, { resultId: 'old', readOnly: true })
    budget.observeResult(latest, { readOnly: true })
    const before = structuredClone(payload)
    assert.equal(budget.fit(payload).fits, false)
    assert.deepEqual(payload, before)
    assert.deepEqual(commits, [])
  }
})

test('inspection allowlist never archives actions, previews, errors or image-bearing results', () => {
  for (const name of ['get_project', 'get_timeline', 'get_assets']) assert.equal(isArchivableInspection(name, result({ clips: [] })), true)
  for (const name of ['edit_trim', 'create_project_checkpoint', 'get_export_status', 'get_generation_queue_status', 'inspect_clip', 'read_result']) {
    assert.equal(isArchivableInspection(name, result({ success: true })), false)
  }
  const refused = [
    null, {}, { content: null }, { isError: true, ...result({}) }, { success: false, ...result({}) },
    result({ success: false }), result({ error: 'Failed' }), result({ previewOnly: true }),
    result({ result: { success: false } }), { ...result({}), structuredContent: { success: false, error: 'Failed' } },
    { ...result({}), structuredContent: { previewOnly: true, previewToken: 'Keep exact token' } },
    { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] },
  ]
  for (const value of refused) assert.equal(isArchivableInspection('get_timeline', value), false, JSON.stringify(value))
  assert.equal(isArchivableInspection('get_timeline', result({}), [{ type: 'image_url' }]), false)
})

test('context compaction keeps its fixed target and image accounting without mutating attachments', () => {
  assert.equal(LOCAL_CONTEXT_BYTES, 163840)
  for (const limitBytes of [0, -1, 1.5, NaN, Infinity, LOCAL_CONTEXT_BYTES + 1]) {
    assert.throws(() => createLocalContextBudget({ archiveResult: () => null, limitBytes }), TypeError)
  }
  const payload = { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }] }
  const original = structuredClone(payload)
  assert.equal(contextBytes(payload), Buffer.byteLength(JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: '[attached image]' } }] }] })) + 8000)
  assert.deepEqual(payload, original)
})

// This is a transport/adapter regression, not a model qualification or real
// project edit. The real production schema catalog is used without starting a
// server; all provider replies and host mutations below are in-memory fixtures.
test('direct catalog router and two nine-clip reads compact older data before checkpoint, trim, and readback without action replay', async () => {
  const { sendLocalWithTools, LIMITS } = require('../electron/connectedAgentLocalTools.cjs')
  const { createComfyStudioMcpServer } = require('../electron/mcpServer.js')
  const guard = { session: 'synthetic-session', projectKey: 'synthetic-project', timelineId: 'timeline-one',
    timelineSessionId: 7, compoundClipId: null, revision: 42 }
  const trimPreview = { mode: 'normal', clipId: 'clip-9', edge: 'end', deltaSeconds: -1, previewOnly: true }
  const trimApply = { ...trimPreview, previewOnly: false, previewToken: 'fixture-single-use-trim-token', expectedContext: guard }
  const checkpointPreview = { label: 'Before synthetic trim', previewOnly: true }
  const checkpointApply = { ...checkpointPreview, previewOnly: false }
  const prompt = 'Read the full nine-clip timeline twice, checkpoint, preview and trim clip-9 by one second, then verify. Do not export, download or generate.'
  const attachment = { name: 'review-notes.json', text: JSON.stringify({ exactUserData: 'KEEP THIS ATTACHED DATA EXACT. '.repeat(140) }) }
  const bodies = [], hostCalls = [], pages = new Map(), headers = new Map()
  let reads = 0, applied = false, checkpointed = false, firstUserMessage, firstSystem, compacted = false
  const fixtureTimeline = large => ({ id: 'timeline-one', name: 'Synthetic nine-clip timeline', duration: 27,
    context: { ...guard, revision: applied ? 43 : 42 }, editingContext: { playheadPosition: 0 },
    clipCounts: { video: 9, total: 9 }, clipLimitApplied: false,
    clips: Array.from({ length: 9 }, (_, i) => ({ id: `clip-${i + 1}`, assetId: `asset-${i + 1}`, type: 'video',
      start: i * 3, duration: i === 8 && applied ? 2 : 3, trimStart: 0, trimEnd: i === 8 && applied ? 2 : 3,
      ...(large ? { authoredMetadata: { notes: `${i + 1}:` + 'z'.repeat(9100), finalMarker: `EXACT_CLIP_${i + 1}_TAIL` } } : {}) })) })
  const mcp = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] })
  const call = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
  const reply = message => new Response(JSON.stringify({ choices: [{ message,
    finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }), { headers: { 'Content-Type': 'application/json' } })
  const split = message => {
    const [line, ...rest] = message.content.split('\n')
    const header = JSON.parse(line), body = rest.join('\n').replace(/^\n/, '')
    if (header.bodyChars !== undefined) assert.equal(body.length, header.bodyChars)
    return { header, body }
  }
  const allRemainingPages = (body, callId, prefix) => {
    const { header, body: initial } = split(body.messages.find(message => message.tool_call_id === callId))
    assert.equal(header.kind, 'local-tool-result-excerpt')
    assert.equal(header.pagingAvailable, true)
    headers.set(callId, header); pages.set(callId, initial)
    const calls = []
    for (let offset = header.nextOffset; offset < header.totalChars; offset += 12000) {
      calls.push(call(`${prefix}-${offset}`, 'read_velorn_tool_result', { resultId: header.resultId, offset }))
    }
    return calls
  }
  const collectPages = (body, callId, prefix) => {
    let text = pages.get(callId)
    for (const message of body.messages.filter(message => message.tool_call_id?.startsWith(`${prefix}-`))) {
      const value = split(message)
      assert.equal(value.header.kind, 'local-tool-result-page')
      assert.equal(value.header.resultId, headers.get(callId).resultId)
      text += value.body
    }
    pages.set(callId, text)
    assert.equal(text.length, headers.get(callId).totalChars)
    for (let i = 1; i <= 9; i++) assert.ok(text.includes(`EXACT_CLIP_${i}_TAIL`))
    assert.ok(text.includes(JSON.stringify(guard)), 'Current guard survives the readable representation exactly')
  }
  const response = await sendLocalWithTools({ model: 'fixture/model-independent', endpoint: 'http://127.0.0.1:1234/v1',
    context: '{}', messages: [{ role: 'user', content: prompt }], documents: [attachment] }, {
    toolSession: { listTools: async () => createComfyStudioMcpServer().tools, callTool: async (name, args) => {
      hostCalls.push({ name, args: structuredClone(args) })
      if (name === 'get_timeline') { reads++; return mcp(fixtureTimeline(reads <= 2)) }
      if (name === 'create_project_checkpoint') {
        if (args.previewOnly) { assert.deepEqual(args, checkpointPreview); return mcp({ success: true, previewOnly: true, context: guard }) }
        assert.equal(checkpointed, false, 'Checkpoint may be stored once only')
        assert.deepEqual(args, checkpointApply); checkpointed = true
        return mcp({ success: true, changed: true, checkpointId: 'fixture-checkpoint', context: guard })
      }
      assert.equal(name, 'edit_trim')
      assert.equal(checkpointed, true)
      if (args.previewOnly) { assert.deepEqual(args, trimPreview); return mcp({ success: true, previewOnly: true, suggestedApplyPayload: trimApply }) }
      assert.equal(applied, false, 'An edit must never be automatically replayed')
      assert.deepEqual(args, trimApply, 'The exact native guard and one-use token must not be rewritten')
      applied = true
      return mcp({ success: true, changed: true, acceptedDeltaSeconds: -1, context: { ...guard, revision: 43 } })
    } },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body); bodies.push(body)
      assert.ok(Buffer.byteLength(options.body) <= LIMITS.requestBytes, 'The transport memory limit remains separate from the compaction target')
      assert.ok(body.tools.some(tool => tool.function.name === 'call_velorn_tool'), 'Every native edit can be called without discovery')
      assert.ok(body.messages[0].content.includes('edit_trim'), 'The legacy trim tool is visible in the initial catalog index')
      assertProtocolPairs(body.messages)
      assert.ok(body.messages.some(message => message.role === 'user' && message.content.includes(prompt)))
      const current = body.messages.find(message => message.role === 'user' && message.content.includes(prompt)).content
      if (!firstUserMessage) { firstUserMessage = current; firstSystem = body.messages[0].content }
      assert.equal(current, firstUserMessage, 'Current instruction and attachment must survive byte-for-byte')
      assert.equal(body.messages[0].content, firstSystem)
      assert.ok(current.includes(JSON.stringify(attachment)))
      const turn = bodies.length
      if (turn === 1) return reply({ tool_calls: [call('read-one', 'get_timeline', { includeClips: true })] })
      if (turn === 2) return reply({ tool_calls: allRemainingPages(body, 'read-one', 'page-one') })
      if (turn === 3) {
        collectPages(body, 'read-one', 'page-one')
        return reply({ tool_calls: [call('read-two', 'get_timeline', { includeClips: true })] })
      }
      if (turn === 4) return reply({ tool_calls: allRemainingPages(body, 'read-two', 'page-two') })
      if (turn === 5) {
        collectPages(body, 'read-two', 'page-two')
        const old = split(body.messages.find(message => message.tool_call_id === 'read-one')).header
        assert.equal(old.kind, 'local-tool-result-reference', 'The first full read must compact under pressure, not simply raise the cap')
        assert.equal(old.resultId, headers.get('read-one').resultId)
        assert.equal(old.complete, false); assert.equal(old.archived, true); compacted = true
        return reply({ tool_calls: [call('checkpoint-preview', 'create_project_checkpoint', checkpointPreview)] })
      }
      if (turn === 6) return reply({ tool_calls: [call('checkpoint-apply', 'create_project_checkpoint', checkpointApply)] })
      if (turn === 7) return reply({ tool_calls: [call('trim-preview', 'edit_trim', trimPreview)] })
      if (turn === 8) {
        const preview = split(body.messages.find(message => message.tool_call_id === 'trim-preview'))
        assert.equal(preview.header.complete, true)
        assert.ok(preview.body.includes('fixture-single-use-trim-token'))
        assert.ok(preview.body.includes(JSON.stringify(guard)))
        return reply({ tool_calls: [call('trim-apply', 'edit_trim', trimApply)] })
      }
      if (turn === 9) return reply({ tool_calls: [call('verify', 'get_timeline', { includeClips: true })] })
      assert.equal(turn, 10)
      const verified = split(body.messages.find(message => message.tool_call_id === 'verify'))
      assert.equal(verified.header.complete, true)
      assert.ok(verified.body.includes('"revision":43'))
      return reply({ content: 'Fixture checkpoint and one-second trim completed once; readback shows the ninth clip ending at 26 seconds.' })
    },
  })
  assert.equal(response.success, true)
  assert.equal(compacted, true); assert.equal(reads, 3); assert.equal(applied, true)
  assert.equal(hostCalls.length, 7)
  assert.deepEqual(hostCalls.map(entry => entry.name), ['get_timeline', 'get_timeline', 'create_project_checkpoint',
    'create_project_checkpoint', 'edit_trim', 'edit_trim', 'get_timeline'])
  assert.equal(bodies.length, 10)
  assert.ok(bodies.every(body => body.tool_choice === 'auto'), 'Compaction does not force a final-only response')
})
