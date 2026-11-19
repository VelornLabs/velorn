'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { validateConnectedAgentArguments, toolArgumentFailure, staleContextFailure, projectConnectedAgentTool, getNativeArgumentFailure } = require('../electron/connectedAgentArguments.cjs')
const { createAgentToolSession } = require('../electron/connectedAgentTools.cjs')
const { createComfyStudioMcpServer } = require('../electron/mcpServer.js')
const clone = value => JSON.parse(JSON.stringify(value))
const context = () => ({ schemaVersion: 1, session: 'renderer-fixture', revision: 3, storyboardRevision: 2,
  projectKey: '/synthetic/private-project-path', timelineId: 'timeline-one', timelineSessionId: 4, compoundClipId: null })
const server = createComfyStudioMcpServer({ performAction: async () => { throw new Error('No real dispatch allowed') } })
const definition = name => server.tools.find(tool => tool.name === name)
const validate = (args, name = 'edit_trim', live = context(), selection = { clipIds: [] }) => validateConnectedAgentArguments(name, args, definition(name), live, selection)
const validTrim = () => ({ mode: 'normal', deltaSeconds: 1, clipId: 'clip-6', edge: 'end', previewOnly: true })
const parsed = result => JSON.parse(result.content[0].text)

test('malformed reported trim yields all actionable field errors without echoing values or changing arguments', () => {
  const args = { mode: 'normal', deltaSeconds: 1, clipId: '["clip-6"]', expectedContext: {}, previewOnly: true }
  const before = clone(args), issues = validate(args)
  assert.deepEqual(issues.map(issue => issue.field).sort(), ['clipId', 'edge', 'expectedContext'])
  assert.deepEqual(args, before)
  const failure = toolArgumentFailure('edit_trim', issues), detail = parsed(failure)
  assert.equal(failure.isError, true); assert.equal(detail.code, 'INVALID_ARGUMENTS')
  assert.equal(detail.actionExecuted, false); assert.equal(detail.outcome, 'not-started')
  assert.equal(detail.error.issues.length, 3)
  assert.doesNotMatch(JSON.stringify(failure), /clip-6|private-project-path|renderer-fixture/)
  assert.deepEqual(getNativeArgumentFailure(failure), detail)
  assert.equal(getNativeArgumentFailure(clone(failure)), null, 'a copied tool/model error cannot claim native pre-dispatch authority')
})
test('context validation follows observed keys and types, without treating valid stale values as malformed', () => {
  for (const supplied of [null, [], '{}', {}, { ...context(), revision: '3' }, { ...context(), session: [] },
    { ...context(), extra: 'private user content' }]) {
    assert.ok(validate({ ...validTrim(), expectedContext: supplied }).some(issue => issue.field === 'expectedContext'))
  }
  for (const supplied of [context(), { ...context(), revision: 1 }, { ...context(), projectKey: '/other' },
    { ...context(), compoundClipId: 'compound-old' }]) {
    assert.deepEqual(validate({ ...validTrim(), expectedContext: supplied }), [])
  }
  const legacy = { session: 'legacy', revision: 0, projectKey: null, timelineId: null, timelineSessionId: 'session', compoundClipId: null }
  assert.deepEqual(validate({ ...validTrim(), expectedContext: legacy }, 'edit_trim', legacy), [])
  assert.equal(parsed(staleContextFailure('edit_trim')).code, 'STALE_EDIT_CONTEXT')
})
test('single and multiple clip targets reject encoded/wrong types but preserve valid IDs and selection fallback', () => {
  for (const clipId of [['clip-6'], '["clip-6"]', '{"id":"clip-6"}', '', null, 6]) {
    assert.ok(validate({ ...validTrim(), clipId }).some(issue => issue.field === 'clipId'))
  }
  for (const clipIds of ['["clip-6"]', ['["clip-6"]'], [['clip-6']], [null], []]) {
    assert.ok(validate({ ...validTrim(), clipIds }).some(issue => issue.field === 'clipIds'))
  }
  assert.deepEqual(validate({ ...validTrim(), clipIds: ['clip-6'], targetClipIds: ['clip-6'] }), [])
  const selected = validTrim(); delete selected.clipId
  assert.deepEqual(validate(selected, 'edit_trim', context(), { clipIds: ['clip-6'] }), [])
  assert.deepEqual(validate({ clipIds: [] }, 'select_clips'), [], 'empty selection clears stay compatible')
  assert.ok(validate({ clips: [{ clipId: '["clip-6"]' }] }, 'trim_clips').some(issue => issue.field === 'clips[0].clipId'))
})
test('trim validation requires the actual mode operands without inventing an edge or coercing deltas', () => {
  for (const mode of ['normal', 'ripple', 'trim']) {
    const args = { ...validTrim(), mode }; delete args.edge
    assert.ok(validate(args).some(issue => issue.field === 'edge'))
  }
  for (const mode of ['slip', 'slide']) {
    const args = { ...validTrim(), mode }; delete args.edge
    assert.deepEqual(validate(args), [])
  }
  for (const deltaSeconds of ['1', null, Infinity]) assert.ok(validate({ ...validTrim(), deltaSeconds }).some(issue => issue.field === 'deltaSeconds'))
  assert.deepEqual(validate({ mode: 'trim', delta: 1, edge: 'out', clipId: 'clip-6' }), [], 'valid native aliases remain unchanged')
  assert.deepEqual(validate({ ...validTrim(), deltaSeconds: 0 }), [], 'no-op preview remains valid')
  assert.ok(validate({ ...validTrim(), previewOnly: 'false' }).some(issue => issue.field === 'previewOnly'))
  assert.ok(validate({ ...validTrim(), previewToken: {} }).some(issue => issue.field === 'previewToken'))
})
test('missing trim target uses only the native single selection and never infers one from a target list or model fields', () => {
  for (const mode of ['normal', 'trim', 'ripple', 'slip', 'slide']) {
    const args = { mode, deltaSeconds: -0.5, edge: 'end', previewOnly: false }
    for (const selection of [undefined, {}, { clipIds: [] }, { clipIds: ['clip-1', 'clip-6'] }, { clipIds: [null] }]) {
      const issues = validateConnectedAgentArguments('edit_trim', args, definition('edit_trim'), context(), selection)
      assert.deepEqual(issues.map(issue => [issue.field, issue.code]), [['clipId', 'trim_target_required']])
      assert.match(issues[0].message, /selecting it first is not required/)
      assert.match(issues[0].message, /get_timeline or inspect_clip/)
    }
    assert.deepEqual(validate(args, 'edit_trim', context(), { clipIds: ['clip-6'] }), [])
    assert.deepEqual(validate({ ...args, clipId: 'clip-6' }), [])
    assert.deepEqual(validate({ ...args, clipId: 'clip-6' }, 'edit_trim', context(), { clipIds: ['clip-1', 'clip-2'] }), [])
    for (const extra of [{ clipIds: ['clip-6'] }, { targetClipIds: ['clip-6'] }, { selection: { clipIds: ['clip-6'] } }]) {
      assert.ok(validate({ ...args, ...extra }).some(issue => issue.code === 'trim_target_required'))
    }
    const malformed = validate({ ...args, clipId: '["clip-6"]' }, 'edit_trim', context(), { clipIds: ['clip-6'] })
    assert.deepEqual(malformed.map(issue => issue.code), ['single_id_required'], 'malformed explicit targets never become selection fallback')
  }
})
test('normal/ripple lists contain their primary, preserve alias precedence and never infer a primary', () => {
  for (const mode of ['normal', 'trim', 'ripple']) {
    for (const field of ['clipIds', 'targetClipIds']) {
      const args = { ...validTrim(), mode, [field]: ['clip-1'] }, before = clone(args)
      assert.deepEqual(validate(args).map(issue => [issue.field, issue.code]), [[field, 'primary_target_required']])
      assert.deepEqual(args, before)
      assert.deepEqual(validate({ ...args, [field]: ['clip-1', 'clip-6'] }), [])
      delete args.clipId
      assert.ok(validate(args, 'edit_trim', context(), { clipIds: ['clip-6'] }).some(issue => issue.code === 'primary_target_required'))
      assert.ok(validate(args).some(issue => issue.code === 'trim_target_required'))
    }
    assert.deepEqual(validate({ ...validTrim(), mode, targetClipIds: ['clip-6'], clipIds: ['clip-1'] }), [])
    assert.ok(validate({ ...validTrim(), mode, targetClipIds: ['clip-1'], clipIds: ['clip-6'] }).some(issue => issue.field === 'targetClipIds'))
  }
  assert.deepEqual(validate({ ...validTrim(), mode: 'slip', targetClipIds: ['clip-1'] }), [], 'unused non-batch fields retain native handling')
})
test('roll requires its inspected pair, not selection or a single primary', () => {
  const args = { mode: 'roll', deltaSeconds: 0.5 }
  assert.deepEqual(validate(args).map(issue => [issue.field, issue.code]), [['clipAId', 'roll_target_required'], ['clipBId', 'roll_target_required']])
  assert.equal(validate({ ...args, clipId: 'clip-6' }, 'edit_trim', context(), { clipIds: ['clip-1', 'clip-6'] }).length, 2)
  assert.deepEqual(validate({ ...args, clipAId: 'clip-1', clipBId: 'clip-6' }), [])
  assert.ok(validate({ ...args, clipAId: 'clip-6', clipBId: 'clip-6' }).some(issue => issue.code === 'distinct_roll_targets_required'))
})
test('legacy token-bound target resolution is deferred to the renderer, without trusting or rewriting the token', () => {
  const args = { mode: 'normal', edge: 'end', deltaSeconds: -0.5, previewOnly: false, previewToken: 'renderer-must-verify', targetClipIds: ['clip-6'] }
  for (const selection of [{ clipIds: [] }, { clipIds: ['clip-1'] }, { clipIds: ['clip-1', 'clip-6'] }]) {
    assert.deepEqual(validate(args, 'edit_trim', context(), selection), [])
  }
  assert.deepEqual(validate({ mode: 'roll', deltaSeconds: 0.5, previewToken: 'renderer-must-verify' }), [])
  assert.ok(validate({ ...args, clipId: '["clip-6"]' }).some(issue => issue.code === 'single_id_required'))
  assert.ok(validate({ ...args, clipId: 'clip-1' }).some(issue => issue.code === 'primary_target_required'))
  assert.ok(validate({ ...args, previewToken: '' }).some(issue => issue.code === 'trim_target_required'))
})
test('connected catalog keeps every public operand and external schema, hiding only supported host-owned controls', () => {
  const original = definition('edit_trim'), before = clone(original), projected = projectConnectedAgentTool(original)
  assert.deepEqual(original, before)
  assert.equal(projected.name, original.name)
  assert.deepEqual(projected.annotations, original.annotations)
  assert.deepEqual(projected.inputSchema.required, original.inputSchema.required)
  assert.equal(projected.inputSchema.properties.expectedContext, undefined)
  assert.equal(projected.inputSchema.properties.previewToken, undefined)
  for (const [field, schema] of Object.entries(original.inputSchema.properties)) {
    if (!['expectedContext', 'previewToken', 'previewOnly', 'edge'].includes(field)) assert.deepEqual(projected.inputSchema.properties[field], schema)
  }
  assert.match(projected.inputSchema.properties.edge.description, /Required.*normal.*ripple/)
  assert.ok(original.inputSchema.properties.expectedContext); assert.ok(original.inputSchema.properties.previewToken)
  for (const name of ['get_timeline', 'queue_prepared_generation', 'export_timeline']) assert.equal(projectConnectedAgentTool(definition(name)), definition(name))
})

test('native errors are structured and pre-dispatch; corrected call may preview while explicit stale controls remain blocked', async () => {
  const live = context(), dispatched = [], approvals = [], events = []
  const session = await createAgentToolSession({ getServer: () => server,
    getContext: async () => ({ context: clone(live), selection: { clipIds: [] }, playhead: 0 }),
    executeTool: async (name, args) => { dispatched.push({ name, args }); return { content: [{ type: 'text', text: JSON.stringify({ previewOnly: true, context: live }) }] } },
    requestApproval: async value => { approvals.push(value); return true }, onEvent: event => events.push(event) })
  const malformed = await session.callTool('edit_trim', { mode: 'normal', deltaSeconds: 1, clipId: '["clip-6"]', expectedContext: {}, previewOnly: true })
  assert.equal(parsed(malformed).code, 'INVALID_ARGUMENTS'); assert.equal(dispatched.length, 0); assert.equal(approvals.length, 0)
  assert.ok(events.some(event => event.status === 'failed' && /Invalid arguments/.test(event.summary)))
  const stale = await session.callTool('edit_trim', { ...validTrim(), expectedContext: { ...live, revision: 2 } })
  assert.equal(parsed(stale).code, 'STALE_EDIT_CONTEXT'); assert.equal(dispatched.length, 0)
  const corrected = await session.callTool('edit_trim', validTrim())
  assert.notEqual(corrected.isError, true); assert.equal(dispatched.length, 1); assert.equal(approvals.length, 0)
  assert.deepEqual(dispatched[0].args, validTrim())
  assert.deepEqual(session.getReceipts().entries.map(entry => entry.outcome), ['failed', 'failed', 'preview'])
})
