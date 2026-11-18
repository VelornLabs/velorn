import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { fixture, plain, deferred, until } from './helpers/audioParityHarness.mjs'

const envelope = { version: 1, offsetSeconds: 2, points: [{ id: 'a', time: 2, db: 0 }, { id: 'b', time: 3, db: -9 }] }

test('public audio tool definitions match renderer actions and describe read-only grouped operations', () => {
  const { tools, writableTools } = createRequire(import.meta.url)('../electron/mcpAudioTools.cjs')
  const actions = fixture().audio()
  for (const name of Object.keys(actions)) assert.ok(tools.some(tool => tool.name === name), name)
  assert.ok(writableTools.includes('set_clip_audio'))
  assert.equal(writableTools.includes('inspect_clip_audio'), false)
  assert.equal(writableTools.includes('list_fonts'), false)
})

test('inspect and default preview expose full audio state without history or document writes', () => {
  const f = fixture(), actions = f.audio(), before = f.store.getState()
  const inspected = actions.inspect_clip_audio({ clipId: 'music' })
  assert.deepEqual(plain(inspected.clips[0].audioEq), { version: 1, enabled: true, lowCut: false, bassDb: 0, midDb: 0, trebleDb: 0 })
  assert.equal(actions.set_clip_audio({ clipId: 'music', volumeEnvelope: envelope }).previewOnly, true)
  assert.equal(f.store.getState(), before)
})

test('combined gain/fades/EQ/envelope batch uses real store actions and one undo boundary', () => {
  const f = fixture(), actions = f.audio(), before = plain(f.clip('music'))
  const plan = actions.set_clip_audio({ clipIds: ['music', 'voice'], gainDb: -3, fadeInSeconds: 99,
    audioEq: { lowCut: true, bassDb: -6 }, volumeEnvelope: envelope })
  const result = actions.set_clip_audio({ clipIds: ['music', 'voice'], gainDb: -3, fadeInSeconds: 99,
    audioEq: { lowCut: true, bassDb: -6 }, volumeEnvelope: envelope, expectedContext: plan.context, previewOnly: false })
  assert.equal(result.changedCount, 2)
  assert.equal(f.store.getState().history.length, 1)
  assert.equal(f.clip('music').gainDb, -3)
  assert.equal(f.clip('music').fadeIn, 8)
  assert.equal(f.clip('voice').audioEq.lowCut, true)
  assert.equal(f.clip('music').audioEq.bassDb, -6)
  assert.deepEqual(plain(f.clip('music').volumeEnvelope), envelope)
  assert.equal(f.store.getState().undo(), true)
  assert.deepEqual(plain(f.clip('music')), before)
  assert.equal(f.store.getState().redo(), true)
  assert.equal(f.clip('music').audioEq.bassDb, -6)
})

test('audio edits survive project-document serialization and resets remain undoable', () => {
  const f = fixture(), actions = f.audio()
  actions.set_clip_audio({ clipId: 'music', audioEq: { midDb: 4 }, volumeEnvelope: envelope, previewOnly: false })
  const saved = JSON.parse(JSON.stringify(f.store.getState().clips))
  f.store.setState({ clips: saved })
  assert.deepEqual(plain(actions.inspect_clip_audio({ clipId: 'music' }).clips[0].volumeEnvelope), envelope)
  actions.set_clip_audio({ clipId: 'music', resetEq: true, resetEnvelope: true, previewOnly: false })
  assert.equal(f.clip('music').audioEq.midDb, 0)
  assert.equal(f.clip('music').volumeEnvelope.points.length, 0)
  f.store.getState().undo()
  assert.equal(f.clip('music').audioEq.midDb, 4)
  assert.equal(f.clip('music').volumeEnvelope.points.length, 2)
})

test('invalid or locked batch targets fail before changing any target or history', () => {
  for (const payload of [{ audioEq: { bassDb: 13 } }, { volumeEnvelope: { ...envelope, points: [envelope.points[0], envelope.points[0]] } }, { gainDb: NaN }]) {
    const f = fixture(), actions = f.audio(), before = f.store.getState()
    assert.throws(() => actions.set_clip_audio({ clipId: 'music', ...payload, previewOnly: false }))
    assert.equal(f.store.getState(), before)
  }
  const f = fixture(), actions = f.audio()
  f.store.setState({ clips: f.store.getState().clips.map(clip => clip.id === 'voice' ? { ...clip, locked: true } : clip) })
  const before = f.store.getState()
  assert.throws(() => actions.set_clip_audio({ clipIds: ['music', 'voice'], gainDb: -9, previewOnly: false }), /Unlock/)
  assert.equal(f.store.getState(), before)
})

test('stale preview rejects and unchanged settings do not create history', () => {
  const f = fixture(), actions = f.audio()
  assert.equal(actions.set_clip_audio({ clipId: 'music', gainDb: 0, previewOnly: false }).changedCount, 0)
  assert.equal(f.store.getState().history.length, 0)
  const plan = actions.set_clip_audio({ clipId: 'music', gainDb: -3 })
  f.store.getState().updateAudioClipProperties('music', { gainDb: -1 }, false)
  assert.throws(() => actions.set_clip_audio({ clipId: 'music', gainDb: -3, expectedContext: plan.context, previewOnly: false }), /changed/)
  assert.equal(f.clip('music').gainDb, -1)
})

test('video-to-audio resolution refuses ambiguous copies of the same source', () => {
  const f = fixture(), actions = f.audio()
  const video = { ...f.clip('video'), assetId: 'music-source', duration: 8, trimEnd: 8 }
  f.store.setState({ clips: [video, { ...f.clip('music') }, { ...f.clip('music'), id: 'copy' }] })
  assert.throws(() => actions.set_clip_audio({ clipId: 'video', gainDb: -3 }), /unique linked audio/)
  f.store.setState({ clips: f.store.getState().clips.map(clip => ['video', 'music'].includes(clip.id) ? { ...clip, linkGroupId: 'linked' } : clip) })
  const result = actions.set_clip_audio({ clipId: 'video', gainDb: -3, previewOnly: false })
  assert.equal(result.clips[0].id, 'music')
  assert.equal(f.clip('copy').gainDb, 0)
})

test('ducking analysis is separate from one-shot undoable apply and cancellation', async () => {
  const f = fixture(), actions = f.audio(), before = f.store.getState()
  assert.equal(actions.audio_ducking({ operation: 'analyze', musicClipId: 'music', dialogueTrackId: 'voice-track' }).previewOnly, true)
  assert.equal(f.counters.analyze, 0)
  const started = actions.audio_ducking({ operation: 'analyze', musicClipId: 'music', dialogueTrackId: 'voice-track', previewOnly: false })
  await until(() => actions.audio_ducking({ jobId: started.job.jobId }).jobs[0].status === 'ready')
  assert.equal(f.store.getState(), before)
  const preview = actions.audio_ducking({ operation: 'apply', jobId: started.job.jobId })
  assert.ok(preview.after.points.some(point => point.db < 0))
  actions.audio_ducking({ operation: 'apply', jobId: started.job.jobId, previewOnly: false })
  assert.equal(f.store.getState().history.length, 1)
  assert.ok(f.clip('music').volumeEnvelope.points.some(point => point.db < 0))
  assert.throws(() => actions.audio_ducking({ operation: 'apply', jobId: started.job.jobId, previewOnly: false }))
  f.store.getState().undo()
  assert.equal(f.clip('music').volumeEnvelope, undefined)
})

test('ducking results cannot land on a changed project and canceled async results are discarded', async () => {
  const pending = deferred(), f = fixture({ analyze: () => pending.promise }), actions = f.audio()
  const started = actions.audio_ducking({ operation: 'analyze', musicClipId: 'music', dialogueTrackId: 'voice-track', previewOnly: false })
  await until(() => f.counters.analyze === 1)
  f.project.currentProjectHandle = '/other/project'
  pending.resolve({ ok: true, envelope })
  await until(() => actions.audio_ducking({ jobId: started.job.jobId }).jobs[0].status === 'failed')
  assert.equal(f.clip('music').volumeEnvelope, undefined)
  const g = fixture({ analyze: () => new Promise(() => {}) }), cancelActions = g.audio()
  const canceled = cancelActions.audio_ducking({ operation: 'analyze', musicClipId: 'music', dialogueTrackId: 'voice-track', previewOnly: false })
  cancelActions.audio_ducking({ operation: 'cancel', jobId: canceled.job.jobId, previewOnly: false })
  assert.equal(cancelActions.audio_ducking({ jobId: canceled.job.jobId }).jobs[0].status, 'canceled')
})

test('interpolation inspect/set/build use existing sampling state and asynchronous ownership', async () => {
  const f = fixture(), actions = f.audio()
  assert.equal((await actions.clip_interpolation({ clipId: 'video' })).clip.frameSampling, 'optical-flow')
  assert.equal((await actions.clip_interpolation({ clipId: 'video', operation: 'build' })).previewOnly, true)
  assert.equal(f.counters.build, 0)
  const started = await actions.clip_interpolation({ clipId: 'video', operation: 'build', previewOnly: false })
  await until(async () => (await actions.clip_interpolation({ jobId: started.job.jobId })).job.status === 'completed')
  assert.equal(f.counters.build, 1)
  assert.equal(f.store.getState().history.length, 0)
  await actions.clip_interpolation({ clipId: 'video', operation: 'set', frameSampling: 'blend', previewOnly: false })
  assert.equal(f.clip('video').frameSampling, 'blend')
  assert.equal(f.store.getState().history.length, 1)
  f.store.getState().undo()
  assert.equal(f.clip('video').frameSampling, 'optical-flow')
  f.project.currentProjectHandle = '/other'
  assert.equal((await actions.clip_interpolation({ jobId: started.job.jobId })).job.belongsToCurrentTimeline, false)
})

test('interpolation cancellation passes an AbortSignal and rejects stale/wrong-owner mutations', async () => {
  const gate = deferred(); let signal
  const f = fixture({ build: (_, options) => { signal = options.signal; return gate.promise }, cancel: () => false }), actions = f.audio()
  const started = await actions.clip_interpolation({ clipId: 'video', operation: 'build', previewOnly: false })
  await until(() => signal)
  await actions.clip_interpolation({ jobId: started.job.jobId, operation: 'cancel', previewOnly: false })
  assert.equal(signal.aborted, true)
  gate.resolve()
  assert.equal((await actions.clip_interpolation({ jobId: started.job.jobId })).job.status, 'canceled')
  f.project.currentTimelineId = 'other'
  await assert.rejects(actions.clip_interpolation({ jobId: started.job.jobId, operation: 'cancel', previewOnly: false }), /Reopen/)
})

test('font discovery uses the shared loader and exposes fallback/source information', async () => {
  const f = fixture(), actions = f.audio()
  const result = await actions.list_fonts({ query: 'helv', forceRefresh: true })
  assert.deepEqual(plain(result.families), ['Helvetica'])
  assert.equal(result.source, 'system')
  assert.equal(result.status, 'ready')
  assert.equal(f.counters.fonts[0].forceRefresh, true)
})
