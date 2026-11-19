'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createAgentToolSession } = require('../electron/connectedAgentTools.cjs')
const { isAutoApprovableEdit, AUTO_APPROVED_EDIT_TOOLS } = require('../electron/connectedAgentEditPolicy.cjs')
const { createComfyStudioMcpServer } = require('../electron/mcpServer.js')
const { createAgentDispatchScope } = require('../electron/connectedAgentDispatch.cjs')

// No server listener, project files, provider, filesystem action or network.
const clone = value => JSON.parse(JSON.stringify(value))
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })
const text = response => response.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
const context = () => ({ schemaVersion: 1, session: 'synthetic-session', projectKey: '/synthetic/auto-edits',
  timelineId: 'timeline-one', timelineSessionId: 1, compoundClipId: null, storyboardRevision: 0, revision: 1 })
const definition = (name, preview = true) => ({ name, description: 'Synthetic safety boundary', inputSchema: {
  type: 'object', properties: preview ? { previewOnly: { type: 'boolean' } } : {},
} })
const marker = { markers: [{ timeSeconds: 1, label: 'Review', color: '#ff8800' }], previewOnly: false }
const eligible = {
  add_timeline_markers: marker,
  remove_timeline_markers: { markerIds: ['m'] },
  set_timeline_marker_properties: { markerIds: ['m'], label: 'Reviewed', timeOffsetSeconds: 1 },
  add_track: { type: 'audio', name: 'Dialogue', channels: 'mono' },
  update_track: { trackId: 't', name: 'Dialogue', muted: true, volume: 0.7 },
  remove_track: { trackId: 't' },
  split_clip: { clipId: 'c', timeSeconds: 2 },
  set_clip_speed: { clipId: 'c', speed: 0.8, reverse: false },
  set_clip_audio: { clipId: 'c', gainDb: -2, volumeEnvelope: { version: 1, points: [{ id: 'p', time: 0, db: -2 }] },
    audioEq: { version: 1, enabled: true, lowCut: false, bassDb: 0, midDb: -1, trebleDb: 0 } },
  set_clip_label_color: { clipIds: ['c'], color: '#ff8800' },
  set_clips_enabled: { clipIds: ['c'], enabled: false },
  move_clips: { clips: [{ clipId: 'c', startSeconds: 2, trackId: 't' }], resolveOverlaps: false },
  trim_clips: { clips: [{ clipId: 'c', durationSeconds: 2 }] },
  edit_trim: { clipId: 'c', mode: 'normal', edge: 'end', deltaSeconds: -1 },
  delete_clips: { clipIds: ['c'], ripple: false },
  duplicate_clip: { clipId: 'c', startSeconds: 4 },
  set_clip_style: { clipIds: ['c'], transform: { positionX: 12, scaleX: 1.2, rotation: 5 }, bypass: { color: false } },
  set_clip_color: { clipIds: ['c'], color: { exposure: 0.5, shadows: { saturation: 0.7 } } },
  edit_clip_effects: { clipIds: ['c'], action: 'add', effectType: 'gaussianBlur', settings: { amount: 4 } },
  set_clip_keyframes: { clipId: 'c', keyframes: [{ property: 'positionX', timeSeconds: 0, value: 12, easing: 'linear' }] },
}

async function fixture(options = {}) {
  const server = createComfyStudioMcpServer()
  if (options.noCheckpoint) server.tools = server.tools.filter(tool => tool.name !== 'create_project_checkpoint')
  for (const extra of options.tools || []) server.tools.push(extra)
  const guard = { context: context(), selection: { clipIds: ['c'], assetIds: [], selectedMarkerId: null }, playhead: 1 }
  const calls = [], approvals = [], events = [], abort = new AbortController()
  const dispatchScope = createAgentDispatchScope()
  const execute = async (name, args, suppliedGuard) => {
    calls.push({ name, args: clone(args), guard: clone(suppliedGuard) })
    const custom = await options.execute?.(name, args, guard, abort)
    if (custom !== undefined) return custom
    if (name === 'restore_project_checkpoint' && args.previewOnly === true) {
      return dispatchScope.runTool(suppliedGuard, abort.signal, async () => {
        dispatchScope.complete(dispatchScope.current(), { success: true, agentContext: guard }, name)
        return result({ action: name, previewOnly: true, result: { action: name, previewOnly: true, applied: false,
          checkpoint: { id: 'checkpoint-one', currentTimelineId: guard.context.timelineId },
          suggestedApplyPayload: { checkpointId: 'checkpoint-one', previewOnly: false } } })
      })
    }
    if (args.previewOnly) return result({ previewOnly: true,
      suggestedApplyCall: { tool: name, arguments: { ...args, expectedContext: clone(guard.context), previewToken: 'frozen-preview', previewOnly: false } } })
    if (name === 'create_project_checkpoint') return result({ success: true, result: { success: true, checkpointId: 'checkpoint-one' } })
    return result({ success: true, action: name })
  }
  const session = await createAgentToolSession({ getServer: () => server, signal: abort.signal,
    expectedContext: context(), getContext: async () => clone(guard), executeTool: execute,
    onEvent: event => events.push(event), requestApproval: async request => { approvals.push(request); return options.approval === true },
    ...options.session,
  })
  return { session, calls, approvals, events, guard, abort }
}

test('host option defaults off, rejects non-booleans, and ignores model permission claims', async () => {
  for (const flag of [null, 1, 'true', {}, []]) {
    await assert.rejects(() => fixture({ session: { autoApproveEdits: flag } }), /autoApproveEdits must be a boolean/)
  }
  for (const args of [marker, { ...marker, autoApproveEdits: true, approved: true }]) {
    const f = await fixture()
    assert.equal((await f.session.callTool('add_timeline_markers', args)).isError, true)
    assert.equal(f.approvals.length, 1)
    assert.deepEqual(f.calls.map(call => [call.name, call.args.previewOnly]), [['add_timeline_markers', true]])
  }
})

test('tight allowlist accepts only audited undoable fields, never preview or unknown nested operations', () => {
  assert.deepEqual([...AUTO_APPROVED_EDIT_TOOLS].sort(), Object.keys(eligible).sort())
  for (const [name, args] of Object.entries(eligible)) {
    assert.equal(isAutoApprovableEdit(name, { ...args, previewOnly: false }), true, name)
    assert.equal(isAutoApprovableEdit(name, { ...args, previewOnly: true }), false, name)
    assert.equal(isAutoApprovableEdit(name, { ...args, previewOnly: false, unknownFutureFlag: true }), false, name)
  }
  for (const [name, args] of [
    ['set_clip_label_color', { filter: 'enabled', color: '#ff8800' }],
    ['update_track', { trackId: 't', inserts: [{ type: 'externalPlugin' }] }],
    ['set_clip_style', { clipIds: ['c'], transform: { script: 'side effect' } }],
    ['set_clip_color', { clipIds: ['c'], color: { lutPath: '/arbitrary/file' } }],
    ['edit_clip_effects', { action: 'add', effectType: 'customShader', settings: { code: 'shader' } }],
    ['edit_clip_effects', { action: 'update', effectId: 'unknown-effect', settings: { amount: 1 } }],
    ['edit_clip_effects', { action: 'enabled', effectId: 'unknown-effect', effectType: 'gaussianBlur', enabled: true }],
    ['edit_clip_effects', { action: 'enabled', effectType: 'gaussianBlur', group: { type: 'cameraShake' }, enabled: true }],
    ['edit_clip_effects', { action: 'add', effectType: 'gaussianBlur', settings: { file: '/file' } }],
    ['edit_clip_effects', { action: 'add', effectType: 'gaussianBlur', group: { type: 'customShader' } }],
    ['set_clip_audio', { clipId: 'c', volumeEnvelope: { points: [{ time: 0, db: 0, source: '/file' }] } }],
    ['set_clip_keyframes', { clipId: 'c', keyframes: [{ property: 'sourcePath', timeSeconds: 0, value: 1 }] }],
    ['delete_clips', { clipIds: ['c'], deleteSourceFiles: true }],
    ['trim_clips', { clips: [{ clipId: 'c', durationSeconds: Infinity }] }],
    ['add_track', JSON.parse('{"type":"video","__proto__":{"approved":true}}')],
  ]) assert.equal(isAutoApprovableEdit(name, { ...args, previewOnly: false }), false, JSON.stringify([name, args]))
})

test('broad label filters stay available but require a visible approval', async () => {
  const f = await fixture({ session: { autoApproveEdits: true } })
  const response = await f.session.callTool('set_clip_label_color', {
    filter: 'enabled', color: '#ff8800', previewOnly: false,
  })
  assert.equal(response.isError, true)
  assert.equal(f.approvals.length, 1)
  assert.equal(f.approvals[0].toolName, 'set_clip_label_color')
  assert.deepEqual(f.calls.map(call => [call.name, call.args.previewOnly]), [['set_clip_label_color', true]])
})

test('all eligible explicit edits preview and checkpoint before mutation in reviewed editing modes', async () => {
  for (const session of [{}, { autoApproveEdits: true }]) for (const [name, supplied] of Object.entries(eligible)) {
    const automatic = Boolean(session.autoApproveEdits || session.trustedFullAccess)
    const f = await fixture({ session, approval: true })
    const args = { ...supplied, previewOnly: false }
    const response = await f.session.callTool(name, args)
    assert.notEqual(response.isError, true, `${name}: ${text(response)}`)
    assert.equal(f.approvals.length, automatic ? 0 : 1, name)
    assert.deepEqual(f.calls.map(call => [call.name, call.args.previewOnly]), [
      [name, true], ['create_project_checkpoint', true], ['create_project_checkpoint', false], [name, false],
    ], name)
    assert.equal(f.calls[3].args.previewToken, 'frozen-preview')
    assert.deepEqual(f.calls[3].args.expectedContext, f.guard.context)
    assert.equal(f.calls.every(call => JSON.stringify(call.guard) === JSON.stringify(f.guard)), true)
    assert.match(text(response), /Safety checkpoint: checkpoint-one/)
    if (automatic) {
      assert.ok(f.events.some(event => event.status === 'running' && event.autoApproved === true && /Auto-approved/.test(event.summary)))
      assert.ok(f.events.some(event => event.status === 'completed' && event.autoApproved === true))
    } else {
      assert.equal(f.approvals[0].toolName, name)
      assert.deepEqual(f.approvals[0].arguments, f.calls[3].args, 'Approval covers the exact frozen edit operands.')
      assert.match(f.approvals[0].warnings.join(' '), /also creates an in-memory Velorn safety checkpoint/)
      assert.ok(f.events.every(event => !event.autoApproved))
    }
  }
})

test('previews never authorize mutations; one checkpoint covers the turn and exact repeats are blocked', async () => {
  const f = await fixture({ session: { autoApproveEdits: true } })
  await f.session.callTool('add_timeline_markers', { markers: marker.markers })
  assert.deepEqual(f.calls.map(call => [call.name, call.args.previewOnly]), [['add_timeline_markers', true]])
  assert.equal(f.approvals.length, 0)
  await f.session.callTool('add_timeline_markers', marker)
  await f.session.callTool('add_track', { type: 'audio', previewOnly: false })
  const repeated = await f.session.callTool('add_timeline_markers', marker)
  assert.equal(repeated.isError, true)
  assert.match(text(repeated), /already dispatched/)
  assert.equal(f.calls.filter(call => call.name === 'create_project_checkpoint' && !call.args.previewOnly).length, 1)
  assert.equal(f.calls.filter(call => call.name === 'add_timeline_markers' && !call.args.previewOnly).length, 1)
  const next = await fixture({ session: { autoApproveEdits: true } })
  await next.session.callTool('add_timeline_markers', marker)
  assert.equal(next.calls.filter(call => call.name === 'create_project_checkpoint' && !call.args.previewOnly).length, 1)
})

test('a model-requested checkpoint without native apply proof cannot replace the host-owned prerequisite', async () => {
  const f = await fixture({ approval: true })
  const explicit = await f.session.callTool('create_project_checkpoint', { label: 'Model-requested checkpoint', previewOnly: false })
  assert.notEqual(explicit.isError, true)
  assert.equal(f.session.getReceipts().entries.at(-1).outcome, 'returned', 'A successful-looking tool result is not native apply proof.')
  const edit = await f.session.callTool('add_timeline_markers', marker)
  assert.notEqual(edit.isError, true, text(edit))
  const checkpoints = f.calls.filter(call => call.name === 'create_project_checkpoint' && call.args.previewOnly === false)
  assert.equal(checkpoints.length, 2, 'The separate prerequisite must be confirmed even if an earlier result claimed success.')
  assert.equal(checkpoints[0].args.label, 'Model-requested checkpoint')
  assert.equal(checkpoints[1].args.label, 'Velorn Agent — before approved undoable edits')
  assert.deepEqual(f.approvals.map(item => item.toolName), ['create_project_checkpoint', 'add_timeline_markers'])
  assert.match(f.approvals[1].warnings.join(' '), /also creates an in-memory Velorn safety checkpoint/)
})

test('dangerous, unknown, mixed and side-effectful preview tools still require manual approval', async () => {
  const server = createComfyStudioMcpServer()
  const excluded = server.tools.filter(tool => !AUTO_APPROVED_EDIT_TOOLS.includes(tool.name)
    && (tool.inputSchema.properties?.previewOnly || ['get_music_generation_status', 'generate_video', 'queue_prepared_generation'].includes(tool.name)))
  excluded.push(definition('get_future_paid_render', false), definition('delete_original_files'), definition('upload_publish'), definition('download_model'), definition('install_custom_node'))
  for (const tool of excluded) {
    if (tool.name === 'check_export_readiness') continue // Existing genuinely read-only exception.
    const f = await fixture({ session: { autoApproveEdits: true }, tools: server.tools.some(item => item.name === tool.name) ? [] : [tool] })
    const args = { previewOnly: false, ...(tool.name === 'clip_interpolation' ? { operation: 'set' } : {}),
      ...(['generate_comfy_router_image', 'generate_create_media'].includes(tool.name) ? { planId: 'router-plan-test' } : {}),
      ...(tool.name === 'generate_local_voice' ? { text: 'Synthetic words' } : {}),
      ...(tool.name === 'audio_ducking' ? { operation: 'cancel' } : {}),
      ...(tool.name === 'run_mcp_action_plan' ? { steps: [{ tool: 'add_track', arguments: { type: 'audio' } }] } : {}) }
    await f.session.callTool(tool.name, args)
    assert.equal(f.approvals.length, 1, tool.name)
    assert.equal(f.calls.some(call => call.args.previewOnly !== true), false, tool.name)
    assert.equal(f.calls.some(call => call.name !== tool.name), false, tool.name)
    assert.equal(f.events.some(event => event.autoApproved), false, tool.name)
  }
})

test('invalid Router generation requests are rejected before approval or dispatch', async () => {
  for (const args of [
    { previewOnly: false },
    { previewOnly: false, prompt: 'A synthetic image' },
    { previewOnly: false, planId: 'router-plan-test', prompt: 'Changed prompt' },
    { previewOnly: false, planId: '../not-a-plan' },
  ]) {
    const f = await fixture({ session: { autoApproveEdits: true } })
    const response = await f.session.callTool('generate_comfy_router_image', args)
    assert.equal(response.isError, true)
    assert.match(text(response), /previewed planId/)
    assert.deepEqual(f.approvals, [], 'Invalid requests cannot reach approval')
    assert.deepEqual(f.calls, [], 'Invalid requests cannot preview or generate')
    assert.equal(f.events.some(event => event.autoApproved), false)
  }
})

test('original and exact preview-suggested payloads independently fail closed', async () => {
  for (const unknownOriginal of [true, false]) {
    const f = await fixture({ session: { autoApproveEdits: true }, execute: (name, args) => {
      if (name !== 'add_track' || !args.previewOnly) return
      return result({ previewOnly: true, suggestedApplyCall: { tool: name, arguments: {
        type: 'audio', previewOnly: false, ...(unknownOriginal ? { autoApproveEdits: undefined } : { installPlugin: true }),
      } } })
    } })
    const response = await f.session.callTool('add_track', { type: 'audio', previewOnly: false, ...(unknownOriginal ? { autoApproveEdits: true } : {}) })
    assert.equal(response.isError, true)
    assert.equal(f.approvals.length, 1)
    assert.equal(f.calls.length, 1)
  }
})

test('unknown original flags cannot be erased while preview is pending to gain authority', async () => {
  const original = { ...marker, approved: true }
  const f = await fixture({ session: { autoApproveEdits: true }, execute: (name, args) => {
    if (name === 'add_timeline_markers' && args.previewOnly) {
      delete original.approved
      return result({ previewOnly: true, suggestedApplyPayload: { approved: undefined } })
    }
  } })
  await f.session.callTool('add_timeline_markers', original)
  assert.equal(f.approvals.length, 1)
  assert.equal(f.calls.length, 1)
})

test('checkpoint failures abort the approved edit in reviewed editing modes, retaining inspection', async () => {
  const scenarios = [
    { noCheckpoint: true },
    { checkpointPreview: result({ previewOnly: true, success: false }) },
    { checkpointPreview: result({ success: true }) },
    { checkpointApply: result({ success: false, error: 'Snapshot failed' }) },
    { checkpointApply: result({ success: true }) },
    { checkpointApply: result({ success: true, checkpointId: '' }) },
    { checkpointApply: result({ success: true, checkpointId: 'x', previewOnly: true }) },
    { checkpointApply: () => { throw new Error('Synthetic RAM checkpoint error') } },
  ]
  for (const session of [{}, { autoApproveEdits: true }]) for (const scenario of scenarios) {
    const f = await fixture({ noCheckpoint: scenario.noCheckpoint, session, approval: true, execute: (name, args) => {
      if (name !== 'create_project_checkpoint') return
      const selected = args.previewOnly ? scenario.checkpointPreview : scenario.checkpointApply
      return typeof selected === 'function' ? selected() : selected
    } })
    const response = await f.session.callTool('add_timeline_markers', marker)
    assert.equal(response.isError, true, JSON.stringify(scenario))
    assert.equal(f.calls.some(call => call.name === 'add_timeline_markers' && !call.args.previewOnly), false)
    const count = f.calls.length
    assert.equal((await f.session.callTool('add_track', { type: 'audio', previewOnly: false })).isError, true)
    assert.equal(f.calls.length, count)
    assert.notEqual((await f.session.callTool('get_timeline')).isError, true)
    assert.equal(f.approvals.length, session.autoApproveEdits || session.trustedFullAccess ? 0 : 1)
  }
})

test('revision, selection, playhead, identity and cancellation guards survive the checkpoint path', async () => {
  for (const session of [{}, { autoApproveEdits: true }]) for (const mutation of [guard => { guard.context.revision += 1 }, guard => { guard.selection.clipIds = ['other'] },
    guard => { guard.playhead += 1 }, guard => { guard.context.projectKey = '/foreign' }, (_, abort) => abort.abort()]) {
    for (const stage of ['edit-preview', 'checkpoint-preview', 'checkpoint-apply']) {
      const f = await fixture({ session, approval: true, execute: (name, args, guard, abort) => {
        if ((stage === 'edit-preview' && name === 'add_timeline_markers' && args.previewOnly)
          || (stage === 'checkpoint-preview' && name === 'create_project_checkpoint' && args.previewOnly)
          || (stage === 'checkpoint-apply' && name === 'create_project_checkpoint' && !args.previewOnly)) mutation(guard, abort)
      } })
      const response = await f.session.callTool('add_timeline_markers', marker)
      assert.equal(response.isError, true, stage)
      assert.equal(f.calls.some(call => call.name === 'add_timeline_markers' && !call.args.previewOnly), false, stage)
    }
  }
})

test('automatic dispatch preserves native export refusal and uncertain-write retry protection', async () => {
  for (const failCheckpoint of [false, true]) {
    const f = await fixture({ session: { autoApproveEdits: true }, execute: (name, args) => {
      if (!args.previewOnly && name === (failCheckpoint ? 'create_project_checkpoint' : 'add_timeline_markers')) {
        throw new Error('Export has priority; mutations are locked')
      }
    } })
    assert.match(text(await f.session.callTool('add_timeline_markers', marker)), /Export has priority/)
    const count = f.calls.length
    assert.equal((await f.session.callTool('add_track', { type: 'audio', previewOnly: false })).isError, true)
    assert.equal(f.calls.length, count)
    assert.equal(f.approvals.length, 0)
  }
})
