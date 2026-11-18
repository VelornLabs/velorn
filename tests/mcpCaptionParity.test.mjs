import assert from 'node:assert/strict'
import test from 'node:test'
import { fixture, plain, deferred, until } from './helpers/audioParityHarness.mjs'

const originalCues = [
  { id: 'first', start: 0, end: 2, text: 'Hello wonderful world', words: [{ text: 'Hello' }, { text: 'wonderful' }, { text: 'world' }] },
  { id: 'last', start: 6, end: 8, text: 'Good night' },
]
const applyDraft = (api, payload = {}) => api.handleUpdateCaptionCues({ target: 'draft', cues: originalCues, audioDuration: 8, previewOnly: false, ...payload })

test('explicit caption model forces local transcription without changing preferences', async () => {
  let options
  const api = fixture().captions({
    getLocalCaptionEngineStatus: async () => ({ binaryPath: '/fake/engine', models: [{ id: 'small' }] }),
    transcribeTimelineAudio: async value => { options = value; return { cues: originalCues, audioDuration: 8 } },
  })
  const job = api.handleTranscribeCaptions({ modelId: 'small', previewOnly: false })
  await until(() => api.handleGetCaptionStatus({ jobId: job.jobId }).job.status !== 'running')
  assert.equal(options.modelId, 'small')
  assert.equal(options.engine, 'local')
  assert.equal(options.strictModel, true)
})

test('missing explicit local model fails without falling back to another engine', async () => {
  let calls = 0
  const api = fixture().captions({
    getLocalCaptionEngineStatus: async () => ({ binaryPath: '/fake/engine', models: [{ id: 'base' }] }),
    transcribeTimelineAudio: async () => { calls++; return {} },
  })
  const job = api.handleTranscribeCaptions({ modelId: 'small', previewOnly: false })
  await until(() => api.handleGetCaptionStatus({ jobId: job.jobId }).job.status === 'error')
  assert.equal(calls, 0)
})

test('caption default preview does not create a draft and status explicitly distinguishes agent and live state', () => {
  const f = fixture(), api = f.captions()
  const preview = api.handleUpdateCaptionCues({ target: 'draft', cues: originalCues })
  assert.equal(preview.previewOnly, true)
  assert.equal(api.handleGetCaptionStatus().draft, null)
  applyDraft(api)
  const status = api.handleGetCaptionStatus()
  assert.equal(status.draft.source, 'agent-session')
  assert.equal(status.draft.belongsToCurrentTimeline, true)
  assert.match(status.note, /separate from an open Caption workspace/)
  assert.equal(status.liveClips.length, 0)
})

test('caption add/split/retime/delete use shared helper semantics and preserve cue words', () => {
  const f = fixture(), api = f.captions()
  applyDraft(api)
  const result = api.handleUpdateCaptionCues({ target: 'draft',
    edits: [{ id: 'last', startSeconds: 6.5, durationSeconds: 1.5 }],
    add: [{ id: 'added', atTimeSeconds: 3, durationSeconds: 1, text: 'New line' }],
    split: [{ id: 'first', caretOffset: 5, rightId: 'right' }], previewOnly: false })
  assert.equal(result.cueCount, 4)
  const first = result.cues.find(cue => cue.id === 'first'), right = result.cues.find(cue => cue.id === 'right')
  assert.equal(first.text, 'Hello')
  assert.equal(right.text, 'wonderful world')
  assert.equal(first.end, right.start)
  assert.equal(first.words.length, 1)
  assert.equal(right.words.length, 2)
  assert.equal(result.cues.find(cue => cue.id === 'added').start, 3)
  assert.equal(result.cues.find(cue => cue.id === 'added').end, 4)
  assert.equal(result.cues.find(cue => cue.id === 'last').end, 8)
  assert.equal(api.handleUpdateCaptionCues({ target: 'draft', removeIds: ['right'], previewOnly: false }).cueCount, 3)
  assert.equal(f.store.getState().history.length, 0, 'agent drafts are not edits to the timeline')
})

test('caption gap/media bounds and duplicate IDs reject before changing the agent draft', () => {
  const f = fixture(), api = f.captions()
  applyDraft(api)
  const before = plain(api.handleGetCaptionStatus().draft)
  for (const payload of [
    { add: [{ atTimeSeconds: 1, text: 'Overlaps' }] },
    { add: [{ atTimeSeconds: 8, text: 'After media' }] },
    { edits: [{ id: 'last', durationSeconds: 4 }] },
    { edits: [{ id: 'first', startSeconds: -1 }] },
    { split: [{ id: 'first', caretOffset: 5, rightId: 'last' }] },
    { cues: [{ ...originalCues[0] }, { ...originalCues[0] }] },
  ]) assert.throws(() => api.handleUpdateCaptionCues({ target: 'draft', ...payload, previewOnly: false }))
  assert.deepEqual(plain(api.handleGetCaptionStatus().draft), before)
})

test('clearing an agent draft is allowed but generation still requires cues', () => {
  const f = fixture(), api = f.captions()
  applyDraft(api)
  assert.equal(api.handleUpdateCaptionCues({ target: 'draft', cues: [], previewOnly: false }).cueCount, 0)
  assert.equal(api.handleGetCaptionStatus().draft.cues.length, 0)
  assert.throws(() => api.handleGenerateCaptions(), /No caption cues/)
})

test('draft revisions and project ownership stop stale apply while explicit replacement starts a new owned draft', () => {
  const f = fixture(), api = f.captions()
  applyDraft(api)
  const revision = api.handleGetCaptionStatus().draftRevision
  api.handleUpdateCaptionCues({ target: 'draft', edits: [{ id: 'first', text: 'Changed' }], previewOnly: false })
  assert.throws(() => api.handleUpdateCaptionCues({ target: 'draft', removeIds: ['first'], expectedDraftRevision: revision, previewOnly: false }), /draft changed/)
  f.project.currentTimelineId = 'other-timeline'
  assert.equal(api.handleGetCaptionStatus().draft.belongsToCurrentTimeline, false)
  assert.throws(() => api.handleUpdateCaptionCues({ target: 'draft', removeIds: ['first'], previewOnly: false }), /another timeline/)
  assert.throws(() => api.handleGenerateCaptions(), /another timeline/)
  assert.throws(() => api.handleGenerateCaptions({ cues: [] }), /No caption cues/)
  const inlinePlan = api.handleGenerateCaptions({ cues: [{ start: 0, end: 1, text: 'Independent' }] })
  assert.equal(inlinePlan.plan.durationSeconds, 1)
  applyDraft(api, { cues: [{ id: 'new', start: 0, end: 1, text: 'Here' }] })
  assert.equal(api.handleGetCaptionStatus().draft.belongsToCurrentTimeline, true)
  assert.equal(api.handleGetCaptionStatus().draft.cues[0].id, 'new')
})

test('suggested caption apply payloads freeze draft revisions as well as authored timeline context', () => {
  const f = fixture(), api = f.captions()
  applyDraft(api)
  const cuePlan = api.handleUpdateCaptionCues({ target: 'draft', removeIds: ['last'] })
  const generatePlan = api.handleGenerateCaptions()
  const transcribePlan = api.handleTranscribeCaptions()
  for (const plan of [cuePlan, generatePlan, transcribePlan]) {
    assert.equal(plan.suggestedApplyPayload.previewOnly, false)
    assert.equal(plan.suggestedApplyPayload.expectedDraftRevision, api.handleGetCaptionStatus().draftRevision)
    assert.ok(plan.suggestedApplyPayload.expectedContext)
  }
  api.handleUpdateCaptionCues({ target: 'draft', edits: [{ id: 'first', text: 'A user edit' }], previewOnly: false })
  assert.throws(() => api.handleUpdateCaptionCues(cuePlan.suggestedApplyPayload), /draft changed/)
  assert.throws(() => api.handleGenerateCaptions(generatePlan.suggestedApplyPayload), /draft changed/)
  assert.throws(() => api.handleTranscribeCaptions(transcribePlan.suggestedApplyPayload), /draft changed/)
})

test('live caption cue readback/edit is visible and undoable, preserving style and independent agent draft', () => {
  const f = fixture(), api = f.captions()
  applyDraft(api)
  const clip = { id: 'captions', type: 'captions', trackId: 'video-track', startTime: 0,
    duration: 8, sourceDuration: 8, trimStart: 0, trimEnd: 8,
    captions: { cues: originalCues.map((cue, index) => ({ ...cue, globalOverrides: { fontFamily: index ? 'Helvetica' : 'Inter', textColor: '#ffffff' } })) } }
  f.store.setState({ clips: [...f.store.getState().clips, clip] })
  assert.equal(api.handleGetCaptionStatus({ clipId: 'captions' }).liveClips[0].cues.length, 2)
  const beforeDraft = plain(api.handleGetCaptionStatus().draft)
  const preview = api.handleUpdateCaptionCues({ target: 'clip', clipId: 'captions', split: [{ id: 'first', caretOffset: 5, rightId: 'right' }] })
  assert.equal(preview.previewOnly, true)
  assert.equal(f.clip('captions').captions.cues.length, 2)
  api.handleUpdateCaptionCues({ target: 'clip', clipId: 'captions', split: [{ id: 'first', caretOffset: 5, rightId: 'right' }], previewOnly: false })
  assert.equal(f.clip('captions').captions.cues.length, 3)
  assert.equal(f.clip('captions').captions.cues[1].globalOverrides.fontFamily, 'Inter')
  assert.deepEqual(plain(api.handleGetCaptionStatus().draft), beforeDraft)
  assert.equal(f.store.getState().history.length, 1)
  f.store.getState().undo()
  assert.equal(f.clip('captions').captions.cues.length, 2)
  api.handleUpdateCaptionCues({ target: 'clip', clipId: 'captions', split: [{ id: 'last', caretOffset: 4, rightId: 'last-right' }], previewOnly: false })
  assert.equal(f.clip('captions').captions.cues.find(cue => cue.id === 'last-right').globalOverrides.fontFamily, 'Helvetica')
})

test('transcription cannot overwrite another timeline or a draft edited while ASR runs', async () => {
  for (const change of ['project', 'draft']) {
    const wait = deferred(), f = fixture(), api = f.captions({ transcribeTimelineAudio: () => wait.promise })
    applyDraft(api)
    const job = api.handleTranscribeCaptions({ previewOnly: false })
    if (change === 'project') f.project.currentProjectHandle = '/other-project'
    else api.handleUpdateCaptionCues({ target: 'draft', edits: [{ id: 'first', text: 'Keep this edit' }], previewOnly: false })
    wait.resolve({ cues: [{ id: 'replacement', start: 0, end: 1, text: 'Stale result' }], audioDuration: 8 })
    await until(() => api.handleGetCaptionStatus({ jobId: job.jobId }).job.status === 'error')
    assert.notEqual(api.handleGetCaptionStatus().draft.cues[0].id, 'replacement')
  }
})

test('caption generation rechecks ownership after sidecar write and never places into a switched timeline', async () => {
  const wait = deferred(), f = fixture(), api = f.captions({ saveCaptionSidecar: () => wait.promise })
  applyDraft(api)
  const job = api.handleGenerateCaptions({ previewOnly: false })
  f.project.currentTimelineId = 'another'
  wait.resolve({})
  await until(() => api.handleGetCaptionStatus({ jobId: job.jobId }).job.status === 'error')
  assert.equal(f.store.getState().clips.filter(clip => clip.type === 'captions').length, 0)
  assert.equal(f.store.getState().history.length, 0)
})

test('baked caption import creates its folder only at final commit and rejects stale disk-write results', async () => {
  for (const switchProject of [false, true]) {
    const disk = deferred(), f = fixture()
    let writing = false
    f.assets.addFolder = folder => { const next = { ...folder, id: 'captions-folder' }; f.assets.folders = [...f.assets.folders, next]; return next }
    f.assets.addAsset = asset => { const next = { ...asset, id: 'caption-asset' }; f.assets.assets = [...f.assets.assets, next]; return next }
    const api = f.captions({
      generateCaptionVideoBlob: async () => new Blob(['synthetic-overlay']),
      buildCaptionAssetName: () => 'Captions.webm',
      ensureCaptionsFolder: (folders, add) => folders[0]?.id || add({ name: 'Captions' }).id,
      writeGeneratedOverlayToProject: async () => { writing = true; return disk.promise },
    })
    applyDraft(api)
    const started = api.handleGenerateCaptions({ placeOnTimeline: false, previewOnly: false })
    await until(() => writing)
    assert.equal(f.assets.folders.length, 0)
    if (switchProject) f.project.currentProjectHandle = '/different-project'
    disk.resolve({ name: 'Captions.webm', duration: 8, path: 'assets/video/Captions.webm' })
    await until(() => api.handleGetCaptionStatus({ jobId: started.jobId }).job.status !== 'running')
    assert.equal(api.handleGetCaptionStatus({ jobId: started.jobId }).job.status, switchProject ? 'error' : 'done')
    assert.equal(f.assets.folders.length, switchProject ? 0 : 1)
    assert.equal(f.assets.assets.some(asset => asset.id === 'caption-asset'), !switchProject)
  }
})
