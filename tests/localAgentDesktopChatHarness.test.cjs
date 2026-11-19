'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const repo = path.resolve(__dirname, '..')
const script = path.join(repo, 'scripts/check-local-agent-desktop-chat.cjs')
const { extractStepEvidence, stepReadEvidence, extractModelVisibleToolEvidence, extractPublicDiscoveryCalls } = require(script)
const run = args => spawnSync(process.execPath, [script, ...args], {
  cwd: repo, encoding: 'utf8', timeout: 20000, maxBuffer: 4 * 1024 * 1024,
})

test('desktop chat diagnostic defaults to a plan without requesting inference', () => {
  const result = run([])
  assert.equal(result.status, 0, result.stderr)
  const plan = JSON.parse(result.stdout)
  assert.equal(plan.actualModelRequests, 0)
  assert.equal(plan.plan.length, 10)
  assert.equal(new Set(plan.plan.map(entry => entry.id)).size, 10)
})

test('desktop chat diagnostic requires an exact model and rejects mixed modes', () => {
  const missingModel = run(['--run'])
  assert.equal(missingModel.status, 1)
  assert.match(missingModel.stderr, /exact loaded model ID/)
  const mixed = run(['--run', '--self-test'])
  assert.equal(mixed.status, 1)
  assert.match(mixed.stderr, /either --self-test or --run/)
})

test('read-only diagnostic exposes one bounded case and dispatches no writes', () => {
  const plan = run(['--inspect-only'])
  assert.equal(plan.status, 0, plan.stderr)
  assert.equal(JSON.parse(plan.stdout).plan.length, 1)
  assert.equal(JSON.parse(plan.stdout).actualModelRequests, 0)
  const result = run(['--self-test', '--inspect-only'])
  assert.equal(result.status, 0, result.stderr + result.stdout)
  const events = result.stdout.trim().split('\n').map(line => JSON.parse(line))
  const summary = events.find(event => event.event === 'summary')
  const report = JSON.parse(fs.readFileSync(summary.report, 'utf8'))
  assert.equal(report.diagnosticMode, 'read-only-inspection')
  assert.equal(report.bounds.overallMs, 90000)
  assert.equal(report.cases.length, 1)
  assert.equal(report.cases[0].executionPassed, true)
  assert.equal(report.cases[0].beforeHash, report.cases[0].afterHash)
  assert.deepEqual(report.cases[0].approvals, [])
  assert.ok(report.cases[0].receipts.entries.every(entry => entry.outcome === 'read'))
})

test('four-stage comparison keeps fixed prompts and proves sequence, previews and effects without inference', () => {
  const mixed = run(['--inspect-only', '--step-comparison'])
  assert.equal(mixed.status, 1)
  assert.match(mixed.stderr, /either --inspect-only or --step-comparison/)
  const plan = run(['--step-comparison'])
  assert.equal(plan.status, 0, plan.stderr)
  assert.equal(JSON.parse(plan.stdout).actualModelRequests, 0)
  assert.equal(JSON.parse(plan.stdout).plan.length, 4)
  const result = run(['--self-test', '--step-comparison'])
  assert.equal(result.status, 0, result.stderr + result.stdout)
  const events = result.stdout.trim().split('\n').map(line => JSON.parse(line))
  const summary = events.find(event => event.event === 'summary')
  const report = JSON.parse(fs.readFileSync(summary.report, 'utf8'))
  assert.equal(report.diagnosticMode, 'four-stage-comparison')
  assert.equal(report.bounds.overallMs, 300000)
  assert.equal(report.bounds.cases, 4)
  assert.equal(report.summary.totalPredictions, 0)
  assert.equal(report.summary.executionPassed, 4)
  assert.equal(report.qualified, false)
  assert.equal(new Set(report.cases.map(c => c.beforeHash)).size, 1)
  assert.ok(!events.some(event => event.event === 'self-test-extra'))
  for (const entry of report.cases) {
    assert.deepEqual(entry.blockedTools, [])
    assert.ok(entry.assertions.every(a => a.passed), entry.name)
    if (entry.case <= 13) assert.equal(entry.beforeHash, entry.afterHash)
    else {
      assert.equal(entry.after.clips.find(c => c.id === 'clip-6').duration, 2.5)
      assert.equal(entry.receipts.entries.filter(e => e.toolName === 'edit_trim' && e.outcome === 'applied').length, 1)
    }
  }
  assert.equal(report.cases[2].stageCrossover, false)
  assert.ok(report.cases[3].publicToolResults.some(r => r.name === 'inspect_clip' && r.trimAppliesAtStart === 1))
})

test('step scoring requires actual returned target timing and ordered model inspection', () => {
  const result = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }] })
  const target = { id: 'clip-6', startTime: 17, duration: 2.5, trimStart: 0 }
  assert.deepEqual(extractStepEvidence('inspect_clip', result({ clip: { ...target, id: 'clip-1' } })), {})
  assert.deepEqual(extractStepEvidence('get_timeline', result({ clipCount: 9 })), {})
  assert.deepEqual(extractStepEvidence('get_timeline', { ...result({ clips: [target] }), isError: true }), {})
  assert.deepEqual(extractStepEvidence('get_timeline', result({ clips: [target] })).returnedTarget,
    { id: 'clip-6', start: 17, duration: 2.5, end: 19.5, sourceIn: 0 })
  const initial = { name: 'get_timeline', trimAppliesAtStart: 0,
    ...extractStepEvidence('get_timeline', result({ clips: [{ ...target, duration: 3 }] })) }
  const preview = { name: 'edit_trim', requestedPreviewOnly: true, trimAppliesAtStart: 0,
    ...extractStepEvidence('edit_trim', result({ result: { success: true, previewOnly: true, plan: { summary: {
      changedCount: 1, before: [{ ...target, duration: 3 }], after: [target],
    } } } })) }
  const fresh = { name: 'inspect_clip', trimAppliesAtStart: 1, ...extractStepEvidence('inspect_clip', result({ clip: target })) }
  assert.equal(stepReadEvidence({ publicToolResults: [initial, preview, fresh] }).verified, true)
  assert.equal(stepReadEvidence({ publicToolResults: [initial, preview] }).verified, false)
  assert.equal(stepReadEvidence({ publicToolResults: [preview, initial] }).initial, false)
  assert.equal(stepReadEvidence({ publicToolResults: [initial, { ...preview, requestedPreviewOnly: false }] }).explicitPreview, false)
  assert.equal(stepReadEvidence({ publicToolResults: [initial, { ...fresh, returnedTarget: undefined, lastPicture: target }] }).verified, false)
})

test('outgoing model evidence records overview coverage and paging headers without prompt or page text', () => {
  const body = {
    kind: 'timeline-overview',
    coverage: { returnedClips: 1, totalClips: 1, allTimelineClipsIncluded: true, allReturnedClipsListed: true, clipLimitApplied: false },
    clips: [{ id: 'clip-6', type: 'video', trackId: 'v1', computedTiming: { timeline: {
      status: 'available', startSeconds: 17, durationSeconds: 3, endSeconds: 20, midpointSeconds: 18.5, endExclusive: true,
    } } }],
    detail: 'OVERVIEW_TEXT_NOT_RETAINED',
  }
  const overview = { role: 'tool', content: JSON.stringify({
    kind: 'local-tool-result-overview', format: 'timeline-overview-v1', toolCallId: 'call-1', resultId: 'result-1',
    overviewComplete: true, detailedResultIncluded: false, bodyChars: JSON.stringify(body).length,
    totalChars: 20000, originalTotalChars: 23000,
  }) + '\n\n' + JSON.stringify(body) }
  const page = { role: 'tool', content: JSON.stringify({
    kind: 'local-tool-result-page', format: 'readable-mcp-v1', representation: 'readable', toolCallId: 'call-1', resultId: 'result-1',
    offset: 0, endOffset: 12000, nextOffset: 12000, totalChars: 20000, bodyChars: 12000,
    complete: false, truncated: true, endOfResult: false,
    deliveryProgress: { newChars: 12000, nextUnreadOffset: 12000, allCharsDelivered: false },
  }) + '\n\nPAGE_BODY_NOT_RETAINED' }
  const evidence = extractModelVisibleToolEvidence([
    overview, page,
    { ...overview, role: 'assistant', reasoning_content: 'PRIVATE_REASONING_NOT_RETAINED' },
    { ...page, role: 'system' },
    { role: 'assistant', content: 'ASSISTANT_TEXT_NOT_RETAINED' },
    { role: 'system', content: 'SYSTEM_TEXT_NOT_RETAINED' },
  ])
  assert.equal(evidence.overviews.length, 1)
  assert.equal(evidence.pages.length, 1)
  assert.equal(evidence.overviews[0].toolCallId, 'call-1')
  assert.equal(evidence.overviews[0].resultId, 'result-1')
  assert.equal(evidence.overviews[0].coverage.allTimelineClipsIncluded, true)
  assert.equal(evidence.overviews[0].bodyChars, JSON.stringify(body).length)
  assert.equal(evidence.overviews[0].detailTotalChars, 20000)
  assert.deepEqual(evidence.overviews[0].rows[0], {
    id: 'clip-6', type: 'video', trackId: 'v1', computedTimeline: {
      status: 'available', startSeconds: 17, durationSeconds: 3, endSeconds: 20, midpointSeconds: 18.5, endExclusive: true,
    },
  })
  assert.equal(evidence.pages[0].offset, 0)
  assert.equal(evidence.pages[0].endOffset, 12000)
  assert.equal(evidence.pages[0].newChars, 12000)
  assert.equal(evidence.pages[0].endOfResult, false)
  assert.equal(evidence.pages[0].representation, 'readable')
  assert.equal(Object.hasOwn(evidence.pages[0], 'raw'), false)
  assert.doesNotMatch(JSON.stringify(evidence), /NOT_RETAINED/)
})

test('outgoing model evidence is bounded and rejects malformed or unrelated transport content', () => {
  const header = { kind: 'local-tool-result-overview', format: 'timeline-overview-v1' }
  const overview = body => ({ role: 'tool', content: JSON.stringify(header) + '\n\n' + JSON.stringify(body) })
  const empty = { overviews: [], pages: [], messagesOmitted: 0,
    discoveryCalls: [], discoveryCallsOmitted: 0, discoveryResults: [], discoveryResultsOmitted: 0 }
  for (const message of [
    { role: 'tool', content: '{invalid}\n\n{}' },
    { role: 'tool', content: JSON.stringify(header) },
    { role: 'tool', content: JSON.stringify({ ...header, format: 'unknown' }) + '\n\n{}' },
    { role: 'tool', content: JSON.stringify({ ...header, padding: 'x'.repeat(4096) }) + '\n\n{}' },
    { role: 'tool', content: JSON.stringify(header) + '\n\n{invalid}' },
    overview({ kind: 'timeline-overview', clips: [], detail: 'x'.repeat(12000) }),
    overview({ kind: 'timeline-overview', clips: 'not-an-array' }),
  ]) assert.deepEqual(extractModelVisibleToolEvidence([message]), empty)
  assert.deepEqual(extractModelVisibleToolEvidence(null), empty)

  const manyRows = overview({ kind: 'timeline-overview', coverage: { allTimelineClipsIncluded: false },
    clips: [{ id: 'x'.repeat(257) }, ...Array.from({ length: 1001 }, () => ({}))] })
  const rows = extractModelVisibleToolEvidence([manyRows]).overviews[0]
  assert.equal(rows.rows.length, 1000)
  assert.equal(rows.rowsOmitted, 2)
  assert.equal(rows.rows[0].id, null)
  assert.equal(rows.coverage.allTimelineClipsIncluded, false)
  const page = { role: 'tool', content: JSON.stringify({ kind: 'local-tool-result-page', offset: -1 }) + '\n\nIGNORED' }
  const messages = extractModelVisibleToolEvidence(Array.from({ length: 70 }, () => page))
  assert.equal(messages.pages.length, 64)
  assert.equal(messages.messagesOmitted, 6)
  assert.equal(messages.pages[0].offset, null)
})

test('public discovery evidence keeps bounded raw selector shapes and matched helper outcomes only', () => {
  const call = (id, args) => ({ id, type: 'function', function: { name: 'discover_velorn_tools', arguments: JSON.stringify(args) } })
  const calls = [call('unknown', { names: ['set_clip_trim'], query: '' }), call('good', { names: ['trim_clips'], query: '' }),
    call('empty', { names: [], query: 'trim' }), call('null', { names: null, query: 'trim' })]
  const helper = (id, result) => ({ role: 'tool', tool_call_id: id, content: JSON.stringify(result) })
  const messages = [{ role: 'assistant', content: 'ASSISTANT_TEXT_NOT_RETAINED', reasoning_content: 'PRIVATE_NOT_RETAINED', tool_calls: calls },
    helper('unknown', { available: false, isError: true, error: { code: 'UNKNOWN_TOOL', message: 'ERROR_TEXT_NOT_RETAINED' },
      activated: [], schemasChanged: false, actionExecuted: false,
      helperProgress: { madeProgress: false, consecutiveNoProgressCalls: 1, maxNoProgressCalls: 3 } }),
    helper('good', { available: true, schemasChanged: true, actionExecuted: false, activated: ['trim_clips'],
      tools: [{ name: 'trim_clips', description: 'SCHEMA_TEXT_NOT_RETAINED' }],
      helperProgress: { madeProgress: true, consecutiveNoProgressCalls: 0, maxNoProgressCalls: 3 } }),
    helper('unmatched', { available: true, activated: ['UNMATCHED_NOT_RETAINED'] }),
    { role: 'system', content: 'SYSTEM_NOT_RETAINED', tool_calls: [call('system', { query: 'SYSTEM_QUERY_NOT_RETAINED' })] }]
  const evidence = extractModelVisibleToolEvidence(messages)
  assert.equal(evidence.discoveryCalls.length, 4)
  assert.deepEqual(evidence.discoveryCalls[0].suppliedArguments, { names: ['set_clip_trim'], query: '' })
  assert.deepEqual(evidence.discoveryCalls[2].suppliedArguments, { names: [], query: 'trim' })
  assert.deepEqual(evidence.discoveryCalls[3].suppliedArguments, { names: null, query: 'trim' })
  assert.equal(evidence.discoveryCalls[2].argumentShapes.names, 'array')
  assert.equal(evidence.discoveryCalls[3].argumentShapes.names, 'null')
  assert.equal(evidence.discoveryResults.length, 2)
  assert.equal(evidence.discoveryResults[0].errorCode, 'UNKNOWN_TOOL')
  assert.equal(evidence.discoveryResults[0].consecutiveNoProgressCalls, 1)
  assert.equal(evidence.discoveryResults[0].schemasChanged, false)
  assert.deepEqual(evidence.discoveryResults[1].activated, ['trim_clips'])
  assert.equal(evidence.discoveryResults[1].schemasChanged, true)
  assert.equal(evidence.discoveryResults[1].madeProgress, true)
  assert.doesNotMatch(JSON.stringify(evidence), /NOT_RETAINED/)
  // A terminal response call is recorded independently; no helper result is
  // invented when no subsequent outgoing request contains one.
  const terminal = extractPublicDiscoveryCalls([call('terminal', { query: 'trim' })])
  assert.equal(terminal.calls[0].toolCallId, 'terminal')
  assert.equal(Object.hasOwn(terminal.calls[0], 'result'), false)

  const bounded = extractPublicDiscoveryCalls([call('long', { names: Array(10).fill('x'.repeat(200)), query: 'q'.repeat(300) }),
    { id: 'bad', function: { name: 'discover_velorn_tools', arguments: '{invalid}' } },
    { id: 'oversized', function: { name: 'discover_velorn_tools', arguments: 'x'.repeat(4097) } }])
  assert.equal(bounded.calls[0].suppliedArguments.names.length, 8)
  assert.equal(bounded.calls[0].suppliedArguments.names[0].length, 128)
  assert.equal(bounded.calls[0].namesOmitted, 2)
  assert.equal(bounded.calls[0].suppliedArguments.query.length, 256)
  assert.equal(bounded.calls[0].argumentsTruncated, true)
  assert.equal(bounded.calls[1].argumentsJsonValid, false)
  assert.equal(bounded.calls[2].argumentsOmitted, true)
  assert.equal(extractPublicDiscoveryCalls(Array(70).fill(call('repeat', { query: 'trim' }))).callsOmitted, 6)
  const malformed = extractModelVisibleToolEvidence([{ role: 'assistant', tool_calls: [call('bad-result', { query: 'trim' })] },
    { role: 'tool', tool_call_id: 'bad-result', content: '{invalid}' }])
  assert.equal(malformed.discoveryResults[0].resultJsonValid, false)
})

test('no-inference self-test exercises the actual desktop handler, approvals, effects and reply guard', () => {
  const result = run(['--self-test'])
  assert.equal(result.status, 0, result.stderr + result.stdout)
  const events = result.stdout.trim().split('\n').map(line => JSON.parse(line))
  const summary = events.find(event => event.event === 'summary')
  assert.equal(summary.selfTest, true)
  assert.equal(summary.executionPassed, 10)
  assert.equal(summary.totalPredictions, 0)
  assert.ok(events.some(event => event.event === 'self-test-extra'
    && event.name === 'prose-plus-tool-markup-after-applied-edit' && event.passed))
  for (const name of ['single-turn-restore-and-fresh-inspection', 'single-turn-restore-empty-final-retains-receipts']) {
    assert.ok(events.some(event => event.event === 'self-test-extra' && event.name === name && event.passed))
  }

  const report = JSON.parse(fs.readFileSync(summary.report, 'utf8'))
  assert.equal(report.qualified, false)
  assert.equal(report.handler, 'registerConnectedAgentIpc CHANNELS.send')
  assert.equal(report.bounds.selectiveRetries, 0)
  assert.equal(report.bounds.cases, 10)
  assert.equal(report.bounds.overallMs, 600000)
  for (const entry of report.cases) {
    assert.equal(entry.instructionEvidence.desktopHandler, true)
    assert.equal(entry.predictions.length, 0)
    assert.deepEqual(entry.blockedTools, [])
    assert.ok(entry.assertions.every(assertion => assertion.passed), entry.name)
  }
  const denied = report.cases.find(entry => entry.case === 6)
  assert.ok(denied.receipts.entries.some(entry => entry.outcome === 'denied'))
  assert.equal(denied.beforeHash, denied.afterHash)
  const repeat = report.cases.find(entry => entry.case === 9)
  assert.equal(repeat.beforeHash, repeat.afterHash)
  assert.deepEqual(repeat.approvals, [])
  const history = report.cases.find(entry => entry.case === 10)
  for (const toolName of ['undo', 'redo']) {
    assert.equal(history.receipts.entries.filter(entry => entry.toolName === toolName
      && entry.outcome === 'applied').length, 1)
  }
})
