'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createAgentToolSession } = require('../electron/connectedAgentTools.cjs')
const { createAgentDispatchScope } = require('../electron/connectedAgentDispatch.cjs')
const { createComfyStudioMcpServer } = require('../electron/mcpServer.js')

const clone = value => structuredClone(value)
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })
const details = value => JSON.parse(value.content[0].text)
const checkpointId = 'checkpoint-approved'
const initialGuard = () => ({ context: { schemaVersion: 1, session: 'renderer-one',
  projectKey: '/synthetic/project', timelineId: 'timeline-one', timelineSessionId: 4,
  compoundClipId: null, revision: 1 }, selection: { clipIds: [] }, playhead: 0 })

async function fixture(options = {}) {
  const guard = initialGuard(), calls = [], approvals = [], abort = new AbortController()
  const scope = createAgentDispatchScope(), server = createComfyStudioMcpServer()
  let latest = checkpointId
  const target = options.otherTimeline ? 'timeline-two' : 'timeline-one'
  const session = await createAgentToolSession({
    getServer: () => server, signal: abort.signal, getContext: async () => clone(guard),
    ...options.mode,
    requestApproval: async request => {
      approvals.push(clone(request))
      return options.approval ? options.approval({ request, guard, setLatest: id => { latest = id } }) : true
    },
    executeTool: async (name, args, supplied) => {
      calls.push({ name, args: clone(args), guard: clone(supplied) })
      if (name !== 'restore_project_checkpoint') return result({ success: true, action: name, timelineId: guard.context.timelineId })
      const preview = args.previewOnly === true
      const checkpoint = { id: args.checkpointId || args.id || latest, currentTimelineId: target }
      const response = await scope.runTool(supplied, abort.signal, async () => {
        if (preview) {
          const record = { action: name, previewOnly: true, applied: false, checkpoint,
            suggestedApplyPayload: { checkpointId: checkpoint.id, previewOnly: false } }
          options.previewRecord?.(record)
          scope.complete(scope.current(), { success: true, agentContext: guard }, options.previewAction || name)
          return result({ action: name, previewOnly: true, result: record })
        }
        const before = clone(guard)
        guard.context.timelineId = target
        guard.context.timelineSessionId++
        guard.context.revision++
        const record = { action: name, success: true, applied: true, restored: true,
          checkpointId: checkpoint.id, restoredTimelineId: target, savedProject: args.saveProject === true,
          restoreTransition: { before, after: clone(guard) } }
        options.record?.(record, guard)
        options.beforeCompletion?.(guard, record)
        if (options.cancel) abort.abort()
        if (options.throwAfterRestore) throw new Error('Synthetic save failed after restore')
        // current() deliberately rejects cancellation; an abandoned completion
        // can never acquire a native receipt or restore continuation authority.
        scope.complete(scope.current(), { success: options.completionSuccess !== false, agentContext: guard }, options.action || name)
        if (options.multipleCompletions) scope.complete(scope.current(), { success: true, agentContext: guard }, name)
        options.afterCompletion?.(guard)
        return result({ action: name, success: options.success !== false, result: record })
      })
      return (preview ? options.copiedPreview : options.copiedApply) ? clone(response) : response
    },
  })
  return { session, guard, calls, approvals, abort, target }
}

for (const mode of [{}, { autoApproveEdits: true }, { trustedFullAccess: true }]) {
  for (const otherTimeline of [false, true]) {
    test(`approved restore continues after one intentional reload (${JSON.stringify(mode)}, other timeline ${otherTimeline})`, async () => {
      const f = await fixture({ mode, otherTimeline })
      assert.equal((await f.session.callTool('restore_project_checkpoint', { checkpointId, previewOnly: false })).isError, undefined)
      assert.equal(details(await f.session.callTool('get_timeline')).timelineId, f.target)
      assert.deepEqual(f.session.getReceipts().entries.map(e => e.outcome), mode.trustedFullAccess ? ['applied', 'read'] : ['preview', 'applied', 'read'])
      assert.equal(f.approvals.length, mode.trustedFullAccess ? 0 : 1)
      assert.equal(f.calls.at(-1).guard.context.timelineSessionId, 5)
      const repeat = await f.session.callTool('restore_project_checkpoint', { checkpointId, previewOnly: false })
      assert.equal(repeat.isError, mode.trustedFullAccess ? undefined : true)
      if (!mode.trustedFullAccess) assert.match(repeat.content[0].text, /already dispatched/)
      assert.equal(f.calls.filter(c => c.name === 'restore_project_checkpoint' && c.args.previewOnly === false).length, mode.trustedFullAccess ? 2 : 1)
      f.guard.context.timelineSessionId++
      assert.equal((await f.session.callTool('get_timeline')).isError, mode.trustedFullAccess ? undefined : true, 'Only reviewed mode freezes the earlier editing context')
    })
  }
}

test('latest checkpoint is resolved by preview, not re-resolved after approval', async () => {
  const f = await fixture({ approval: ({ request, setLatest }) => {
    assert.equal(request.arguments.checkpointId, checkpointId)
    setLatest('checkpoint-created-while-waiting')
    return true
  } })
  const restored = details(await f.session.callTool('restore_project_checkpoint', { previewOnly: false }))
  assert.equal(restored.result.checkpointId, checkpointId)
  assert.equal((await f.session.callTool('get_timeline')).isError, undefined)
})

for (const scenario of ['denied', 'stale', 'preview-only']) {
  test(`restore ${scenario} does not apply or adopt a new session`, async () => {
    const f = await fixture({ approval: ({ guard }) => {
      if (scenario === 'stale') guard.context.revision++
      return scenario !== 'denied'
    } })
    await f.session.callTool('restore_project_checkpoint', { checkpointId, previewOnly: scenario === 'preview-only' })
    assert.equal(f.guard.context.timelineSessionId, 4)
    assert.equal(f.calls.some(c => c.args.previewOnly === false), false)
    assert.equal(f.session.getReceipts().entries.some(e => e.outcome === 'applied'), false)
  })
}

for (const [scenario, options] of Object.entries({
  'copied preview': { copiedPreview: true },
  'wrong preview action': { previewAction: 'get_timeline' },
  'missing preview target': { previewRecord: record => { delete record.checkpoint.currentTimelineId } },
  'inconsistent preview ID': { previewRecord: record => { record.checkpoint.id = 'checkpoint-unapproved' } },
})) {
  test(`unproven restore preview fails before approval/apply: ${scenario}`, async () => {
    const f = await fixture(options)
    assert.equal((await f.session.callTool('restore_project_checkpoint', { checkpointId, previewOnly: false })).isError, true)
    assert.equal(f.approvals.length, 0)
    assert.equal(f.calls.some(c => c.args.previewOnly === false), false)
  })
}

const invalidTransitions = {
  'copied result': { copiedApply: true },
  'wrong completion action': { action: 'open_project' },
  'multiple completions': { multipleCompletions: true },
  'failed completion': { completionSuccess: false },
  'failed result': { success: false },
  'missing applied effect': { record: r => { delete r.applied } },
  'wrong checkpoint': { record: r => { r.checkpointId = 'checkpoint-other' } },
  'wrong returned timeline': { record: r => { r.restoredTimelineId = 'timeline-other' } },
  'wrong target timeline': { record: (r, g) => { g.context.timelineId = 'timeline-other'; r.restoredTimelineId = g.context.timelineId; r.restoreTransition.after = clone(g) } },
  'different project': { record: (r, g) => { g.context.projectKey = '/synthetic/other'; r.restoreTransition.after = clone(g) } },
  'different renderer': { record: (r, g) => { g.context.session = 'renderer-two'; r.restoreTransition.after = clone(g) } },
  'compound destination': { record: (r, g) => { g.context.compoundClipId = 'compound-one'; r.restoreTransition.after = clone(g) } },
  'second timeline reload': { record: (r, g) => { g.context.timelineSessionId++; r.restoreTransition.after = clone(g) } },
  'missing immediate context': { record: r => { delete r.restoreTransition } },
  'wrong immediate before': { record: r => { r.restoreTransition.before.context.revision++ } },
  'edit during bridge await': { beforeCompletion: g => { g.context.revision++ } },
  'selection during bridge await': { beforeCompletion: g => { g.selection.clipIds = ['different-clip'] } },
  'playhead during bridge await': { beforeCompletion: g => { g.playhead = 9 } },
  'edit before post-read': { afterCompletion: g => { g.context.revision++ } },
  'save was not confirmed': { record: r => { r.savedProject = false }, save: true },
  'save threw after restore': { throwAfterRestore: true, save: true },
  'cancelled after restore': { cancel: true },
}
for (const [scenario, options] of Object.entries(invalidTransitions)) {
  test(`restore cannot acquire authority from ${scenario}`, async () => {
    const f = await fixture(options)
    await f.session.callTool('restore_project_checkpoint', { checkpointId, previewOnly: false, ...(options.save ? { saveProject: true } : {}) })
    assert.equal(f.session.getReceipts().entries.some(e => e.outcome === 'applied'), false)
    const dispatched = f.calls.length
    assert.equal((await f.session.callTool('get_timeline')).isError, true)
    assert.equal((await f.session.callTool('restore_project_checkpoint', { checkpointId, previewOnly: false })).isError, true)
    assert.equal(f.calls.length, dispatched, 'No further dispatch or replay after an uncertain transition')
  })
}
