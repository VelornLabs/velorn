import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { File } from 'node:buffer'
import test from 'node:test'
import * as handoff from '../electron/generationHandoff.mjs'
import * as musicModels from '../src/services/musicGenerationModels.mjs'

// Pure contracts and actual renderer/native handlers, with in-memory stores and
// synthetic queue/capture boundaries. No app, network, model or project writes.
const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8')
const generate = read('../src/components/GenerateWorkspace.jsx')
const actions = read('../src/services/mcpActions.js')
const modifiers = read('../src/services/comfyui.js')
const plain = value => JSON.parse(JSON.stringify(value))
function between(source, first, last) {
  const start = source.indexOf(first)
  const end = source.indexOf(last, start)
  assert.ok(start >= 0 && end > start, `Actual source boundaries: ${first}`)
  return source.slice(start, end)
}
const audioAsset = { id: 'song', name: 'Song', type: 'audio', duration: 120 }
const request = { workflowId: 'ltx23-ia2v', durationSeconds: 3, fps: 24,
  resolution: { width: 1920, height: 1080 }, audioAssetId: 'song', audioStartSeconds: 32 }
const makeFrame = () => ({ source: 'mcp', category: 'video', workflowId: request.workflowId,
  prompt: 'A quiet tracking shot', negativePrompt: '', file: new File(['picture'], 'shot.png', { type: 'image/png' }),
  generationSettings: handoff.buildStagedGenerationSettings(request, [audioAsset]) })

test('explicit three-second LTX settings remain exact; presets do not constrain them', () => {
  const settings = handoff.buildStagedGenerationSettings(request, [audioAsset])
  assert.equal(settings.durationSeconds, 3)
  assert.equal(settings.fps, 24)
  assert.deepEqual(settings.resolution, { width: 1920, height: 1080 })
  assert.deepEqual(settings.audio, { assetId: 'song', assetName: 'Song', startSeconds: 32,
    durationSeconds: 3, sourceDurationSeconds: 120, source: 'explicit_audio_asset_range', timelineAudioMatched: false })
  for (const workflowId of ['ltx23-i2v', 'ltx23-ia2v', 'ltx23-id-lora', 'ltx23-t2v']) {
    assert.equal(handoff.supportsExplicitGenerationDuration(workflowId), true)
    assert.equal(handoff.buildStagedGenerationSettings({ workflowId, durationSeconds: 3 }).durationSeconds, 3)
  }
})

test('staging rejects unsupported or silently rounded settings and invalid audio source ranges', () => {
  for (const [overrides, message] of [
    [{ durationSeconds: 0 }, /positive/], [{ durationSeconds: Infinity }, /positive/],
    [{ durationSeconds: 0.5 }, /at least 1/], [{ fps: 23.976 }, /whole number/],
    [{ resolution: { width: 127.5, height: 720 } }, /whole pixels/],
    [{ resolution: { width: 128, height: 720 } }, /at least 256/],
    [{ audioAssetId: 'missing' }, /existing project audio/],
    [{ audioAssetId: null, audioStartSeconds: 32 }, /Provide audioAssetId/],
    [{ audioStartSeconds: -1 }, /non-negative/], [{ audioStartSeconds: 118 }, /exceeds/],
    [{ workflowId: 'ltx23-i2v' }, /supported by ltx23-ia2v only/],
  ]) assert.throws(() => handoff.buildStagedGenerationSettings({ ...request, ...overrides }, [audioAsset]), message)
  assert.throws(() => handoff.buildStagedGenerationSettings({ workflowId: 'ltx23-i2v', durationSeconds: 3.5 }), /whole-second/)
  assert.throws(() => handoff.buildStagedGenerationSettings(request, [{ ...audioAsset, duration: null }]), /source duration/)
})

test('a picture-only IA2V preparation clears old audio; selected audio reports source start, never timeline matching', () => {
  assert.equal(handoff.buildStagedGenerationSettings({ workflowId: 'ltx23-ia2v', durationSeconds: 3 }).audio, null)
  const selected = handoff.describeConditioningAudio({ workflowId: 'ltx23-ia2v', asset: audioAsset, duration: 3 })
  assert.equal(selected.startSeconds, 0)
  assert.equal(selected.source, 'selected_audio_asset_from_start')
  assert.equal(selected.timelineAudioMatched, false)
  assert.equal(handoff.describeConditioningAudio({ workflowId: 'ltx23-ia2v', asset: audioAsset, duration: 3, frame: makeFrame() }).startSeconds, 32)
  const otherWorkflow = handoff.describeConditioningAudio({ workflowId: 'ltx23-id-lora', asset: audioAsset, duration: 3 })
  assert.equal(otherWorkflow.startSeconds, null)
  assert.equal(otherWorkflow.durationSeconds, null, 'unverified graph audio ranges must not be invented')
})

test('review tokens are exact, expiring and single use across settings, input identity and context changes', () => {
  let time = 0
  let serial = 0
  const reviews = handoff.createPreparedGenerationReviews({ now: () => time, token: () => `review-${++serial}`, maxAgeMs: 10 })
  const snapshot = { duration: 3, fps: 24, input: 'shot-10', audio: request }
  const context = { projectKey: 'project-1', revision: 5 }
  const token = reviews.preview(snapshot, context)
  assert.equal(reviews.preview(snapshot, context, token), token)
  for (const changed of [{ ...snapshot, duration: 5 }, { ...snapshot, input: 'shot-11' }, { ...snapshot, audio: { ...request, audioStartSeconds: 0 } }]) {
    assert.throws(() => reviews.consume(token, changed, context), /changed after preview/)
  }
  assert.throws(() => reviews.consume(token, snapshot, { ...context, revision: 6 }), /changed after preview/)
  reviews.consume(token, snapshot, context)
  assert.throws(() => reviews.consume(token, snapshot, context), /already used/)
  const expired = reviews.preview(snapshot, context)
  time = 11
  assert.throws(() => reviews.consume(expired, snapshot, context), /expired/)
})

function prepareHarness({ changeDuringCapture = false, showGenerateTab = true } = {}) {
  let revision = 1
  const state = { frame: null, events: [], revoked: [], captures: 0 }
  const source = between(actions, 'async function handlePrepareGenerationFromTimelineContext(', 'async function handleQueuePreparedGeneration(')
  const prepare = vm.runInNewContext(`${source}; handlePrepareGenerationFromTimelineContext`, {
    ...handoff, globalThis: { crypto: { randomUUID: () => 'preparation-1' } },
    useTimelineStore: { getState: () => ({ timelineFps: 24, playheadPosition: 32 }) },
    useAssetsStore: { getState: () => ({ assets: [audioAsset] }) },
    useFrameForAIStore: { getState: () => ({ setFrame: frame => { state.frame = frame } }) },
    getShowGenerateTab: () => showGenerateTab,
    resolveMcpGenerationResolution: payload => payload.resolution,
    captureMcpContext: () => ({ revision }),
    assertMcpContext: expected => { if (expected.revision !== revision) throw new Error('Project changed during preparation') },
    roundToTimelineFrame: time => time,
    getTopmostVideoOrImageClipAtTime: () => ({ clip: { id: 'shot-10' }, track: { id: 'v1' } }),
    captureTimelineFrameAt: async () => { state.captures++; if (changeDuringCapture) revision++; return { file: makeFrame().file, blobUrl: 'blob:captured' } },
    summarizeClip: clip => clip, summarizeTrack: track => track,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail } },
    window: { dispatchEvent: event => state.events.push(event) },
    URL: { revokeObjectURL: url => state.revoked.push(url) },
  })
  return { prepare, state }
}

test('actual prepare handler stores settings before opening Generate (including cold first mount)', async () => {
  const { prepare, state } = prepareHarness()
  const result = await prepare({ ...request, timeSeconds: 32, prompt: 'A quiet tracking shot' })
  assert.equal(state.captures, 1)
  assert.equal(state.frame.preparationId, 'preparation-1')
  assert.deepEqual(plain(state.frame.generationSettings), result.stagedSettings)
  assert.equal(state.frame.generationSettings.durationSeconds, 3)
  assert.equal(state.events[0].type, 'comfystudio-mcp-prepare-generation')
  assert.equal(state.events[1].type, 'comfystudio-open-generate-with-frame')
  assert.equal(result.conditioningAudio.startSeconds, 32)
  assert.equal(result.openedGenerateTab, true)
})

test('hidden Generate preparation retains exact staging and reports background work instead of claiming navigation', async () => {
  const { prepare, state } = prepareHarness({ showGenerateTab: false })
  const result = await prepare({ ...request, timeSeconds: 32 })
  assert.equal(result.success, true)
  assert.equal(result.openedGenerateTab, false)
  assert.match(result.message, /tab remains hidden/)
  assert.equal(state.frame.generationSettings.durationSeconds, 3)
  assert.equal(state.events[1].type, 'comfystudio-open-generate-with-frame')
  assert.equal(result.conditioningAudio.startSeconds, 32)
})

test('project edits during async capture abort staging and release only the new captured URL', async () => {
  const { prepare, state } = prepareHarness({ changeDuringCapture: true })
  await assert.rejects(prepare(request), /Project changed/)
  assert.equal(state.frame, null)
  assert.deepEqual(state.events, [])
  assert.deepEqual(state.revoked, ['blob:captured'])
})

test('actual first-mount callback restores workflow, 3s, FPS, resolution and exact audio without any event', () => {
  const state = { selectedTags: ['stale tag'], duration: 5, fps: 30 }
  const bindings = { useCallback: callback => callback, appliedStagedFrame: { current: null },
    getWorkflowManifestByWorkflowId: id => ({ id, route: 'local' }),
    useAssetsStore: { getState: () => ({ assets: [audioAsset] }) } }
  for (const key of ['generationMode', 'category', 'workflowId', 'selectedWorkflowManifestId', 'workflowRoute',
    'selectedAssetId', 'selectedAsset', 'prompt', 'selectedTags', 'negativePrompt', 'duration', 'fps', 'resolution',
    'imageResolution', 'selectedAudioAssetId', 'selectedAudioAsset', 'formError', 'workflowDetailOpen']) {
    bindings[`set${key[0].toUpperCase()}${key.slice(1)}`] = value => { state[key] = value }
  }
  const source = between(generate, 'const applyStagedFrame = useCallback(', '  useEffect(() => { applyStagedFrame')
  const apply = vm.runInNewContext(`${source}; applyStagedFrame`, bindings)
  const frame = makeFrame()
  assert.equal(apply(frame), true)
  assert.equal(state.workflowId, 'ltx23-ia2v')
  assert.equal(state.workflowDetailOpen, true)
  assert.equal(state.duration, 3)
  assert.equal(state.fps, 24)
  assert.deepEqual(state.resolution, request.resolution)
  assert.equal(state.selectedAudioAsset, audioAsset)
  assert.equal(state.selectedAsset, null)
  assert.deepEqual(plain(state.selectedTags), [])
  state.duration = 8
  assert.equal(apply(frame), false, 'a repeated event does not overwrite user edits')
  assert.equal(state.duration, 8)
  const pictureOnly = { ...makeFrame(), generationSettings: { durationSeconds: 3, audio: null } }
  apply(pictureOnly)
  assert.equal(state.selectedAudioAsset, null)
})

function effectBeforeMarker(marker) {
  const end = generate.indexOf(marker)
  const start = generate.lastIndexOf('  useEffect(() => {', end)
  const close = generate.indexOf('\n  }, [', end)
  assert.ok(start >= 0 && close > end)
  return generate.slice(start + '  useEffect('.length, close) + '\n  }'
}

test('cold-mount normalization effects cannot overwrite the staged values from stale persisted state', () => {
  const frame = makeFrame()
  let duration = 3, workflow = 'ltx23-ia2v', resolution = request.resolution
  const scope = { ...handoff, frameForAI: frame, durationNormalizationFrame: { current: null },
    resolutionNormalizationFrame: { current: null }, workflowNormalizationFrame: { current: null },
    generationMode: 'single', category: 'video', workflowId: 'invalid-persisted-workflow',
    duration: 11, videoDurationPresets: [2, 3, 5, 8], resolution: { width: 3840, height: 2160 },
    currentCategoryWorkflows: [{ id: 'wan22-i2v' }], isImportedWorkflowId: () => false,
    setDuration: value => { duration = value }, setWorkflowId: value => { workflow = value }, setResolution: value => { resolution = value } }
  vm.runInNewContext(`(${effectBeforeMarker('// LTX supports explicit durations')})()`, scope)
  vm.runInNewContext(`(${effectBeforeMarker("resolutionNormalizationFrame.current = frameForAI")})()`, scope)
  vm.runInNewContext(`(${effectBeforeMarker("workflowNormalizationFrame.current = frameForAI")})()`, scope)
  assert.equal(duration, 3)
  assert.equal(workflow, 'ltx23-ia2v')
  assert.deepEqual(resolution, request.resolution)
  scope.workflowId = 'ltx23-ia2v'; scope.duration = 3
  vm.runInNewContext(`(${effectBeforeMarker('// LTX supports explicit durations')})()`, scope)
  assert.equal(duration, 3, 'second render treats LTX preset buttons as suggestions')
  scope.workflowId = 'wan22-i2v'; scope.duration = 11
  vm.runInNewContext(`(${effectBeforeMarker('// LTX supports explicit durations')})()`, scope)
  assert.equal(duration, 8, 'ordinary non-LTX UI behavior remains unchanged')
})

function queueHarness(overrides = {}) {
  const frame = makeFrame()
  const state = { queued: 0, context: { revision: 1, projectKey: 'synthetic' }, liveFrame: frame }
  const scope = { ...handoff, frameForAI: frame, workflowId: request.workflowId, category: 'video', generationMode: 'single',
    selectedWorkflowManifest: { title: 'LTX IA2V', requiresAudio: true, runnable: true }, currentWorkflow: { needsImage: true },
    isSingleVideoWorkflowId: id => id.startsWith('ltx23-'), isConnected: true, allowQueueWhileWaiting: false,
    queueRef: { current: [] }, ACTIVE_JOB_STATUSES: ['running'], fullPrompt: frame.prompt, negativePrompt: '',
    duration: 3, fps: 24, resolution: request.resolution, effectiveImageResolution: request.resolution,
    conditioningAudio: handoff.describeConditioningAudio({ workflowId: request.workflowId, asset: audioAsset, duration: 3, frame }),
    dependencyCheckInProgress: false, hasBlockingDependencies: false, primaryAssetSlot: { id: 'image' }, assetInputSlots: [],
    selectedAssetFields: {}, customGenerateImageValidation: { ok: true }, customGenerateVideoValidation: { ok: true },
    selectedAsset: null, selectedAudioAsset: audioAsset, selectedAssetFieldIds: {}, referenceAssetId1: null, referenceAssetId2: null,
    templateParameterValues: {}, seed: 123, interpolationMultiplier: 4, enableFpsMultiplier: false,
    wanQualityPreset: 'balanced', editSteps: 10, editCfg: 1, musicTags: '', lyrics: '', musicDuration: 30, bpm: 120, keyscale: 'C', frameTime: 0,
    selectedMusicLength: { lengthMode: 'exact', durationSeconds: 30 },
    isImportedWorkflowId: () => false, CUSTOM_GENERATE_IMAGE_WORKFLOW_ID: 'custom-image', CUSTOM_GENERATE_VIDEO_WORKFLOW_ID: 'custom-video',
    captureMcpContext: () => state.context,
    assertMcpContext: expected => { assert.deepEqual(plain(expected), state.context) },
    useFrameForAIStore: { getState: () => ({ frame: state.liveFrame }) },
    preparedGenerationReviews: handoff.createPreparedGenerationReviews({ token: () => `token-${Math.random()}` }),
    handleGenerate: () => { state.queued++; return { success: true, queued: 1, job: { workflowId: request.workflowId } } },
    addComfyLog: () => {}, ...overrides }
  const listener = generate.indexOf("window.addEventListener('comfystudio-mcp-queue-prepared-generation'")
  const start = generate.lastIndexOf('const handler = (event) => {', listener)
  const handler = vm.runInNewContext(`${generate.slice(start, listener)}; handler`, scope)
  return { state, scope, call(detail = {}) { let result; handler({ detail: { ...detail, respond: value => { result = value } } }); return result } }
}

test('actual prepared queue previews exact 3s/audio range, applies once, and never queues from preview', () => {
  const h = queueHarness()
  const preview = h.call()
  assert.equal(preview.success, true)
  assert.equal(preview.status.duration, 3)
  assert.equal(preview.status.conditioningAudio.startSeconds, 32)
  assert.equal(preview.status.conditioningAudio.timelineAudioMatched, false)
  assert.equal(h.state.queued, 0)
  assert.equal(h.call(preview.suggestedApplyPayload).success, true)
  assert.equal(h.state.queued, 1)
  assert.equal(h.call(preview.suggestedApplyPayload).success, false)
  assert.equal(h.state.queued, 1)
})

test('actual prepared queue refuses coerced settings, missing audio, not-ready state and unstaged mount races', () => {
  for (const overrides of [{ duration: 5 }, { fps: 30 }, { resolution: { width: 1280, height: 720 } },
    { fullPrompt: 'unreviewed change' }, { conditioningAudio: null }, { isConnected: false },
    { dependencyCheckInProgress: true }, { hasBlockingDependencies: true }]) {
    const h = queueHarness(overrides)
    assert.equal(h.call().success, false, JSON.stringify(overrides))
    assert.equal(h.state.queued, 0)
  }
  assert.equal(queueHarness({ duration: 5 }).call({ requireTimelineFrame: false }).success, false,
    'not requiring a frame does not bypass the reviewed settings for a frame actually used')
  const h = queueHarness()
  h.state.liveFrame = makeFrame()
  assert.match(h.call().error, /still updating/)
  assert.equal(h.state.queued, 0)
})

test('actual queue rejects apply without preview, changed seed/audio/frame or document, but supports exact repreview', () => {
  const missing = queueHarness()
  assert.equal(missing.call({ previewOnly: false, expectedContext: missing.state.context }).success, false)
  assert.equal(missing.state.queued, 0)
  for (const change of [h => { h.scope.seed = 987 }, h => { h.scope.selectedAudioAsset = { ...audioAsset } },
    h => { h.scope.frameForAI = h.state.liveFrame = makeFrame() }, h => { h.state.context = { ...h.state.context, revision: 2 } }]) {
    const h = queueHarness()
    const preview = h.call()
    assert.equal(h.call({ ...preview.suggestedApplyPayload, previewOnly: true }).previewToken, preview.previewToken)
    change(h)
    assert.equal(h.call(preview.suggestedApplyPayload).success, false)
    assert.equal(h.state.queued, 0)
  }
})

test('prepared music previews freeze Automatic/custom maximum independently from generic video duration', () => {
  const overrides = { workflowId: 'music-gen-yue2', category: 'audio',
    selectedWorkflowManifest: { title: 'YuE2', runnable: true }, currentWorkflow: {}, primaryAssetSlot: null,
    conditioningAudio: null, selectedMusicLength: { lengthMode: 'automatic', durationSeconds: 360 } }
  const h = queueHarness(overrides)
  const preview = h.call({ requireTimelineFrame: false })
  assert.equal(preview.success, true)
  assert.equal(preview.status.musicLengthMode, 'automatic')
  assert.equal(preview.status.musicDuration, 360)
  assert.equal(preview.status.duration, 3, 'music maximum never replaces generic video seconds')
  assert.equal(h.call(preview.suggestedApplyPayload).success, true)
  for (const length of [{ lengthMode: 'custom', durationSeconds: 360 }, { lengthMode: 'custom', durationSeconds: 95 }]) {
    const changed = queueHarness(overrides)
    const reviewed = changed.call({ requireTimelineFrame: false })
    changed.scope.selectedMusicLength = length
    assert.equal(changed.call(reviewed.suggestedApplyPayload).success, false)
    assert.equal(changed.state.queued, 0)
  }
})

test('actual IA2V graph receives 3s/24fps/1920x1080 and explicit 32s source trim, with safe missing-control failure', () => {
  const source = between(modifiers, 'export function modifyLTX23IA2VWorkflow(', '/**\n * Workflow modifier for LTX 2.3 ID-LoRA')
  const modify = vm.runInNewContext(`${source.replace('export ', '')}; modifyLTX23IA2VWorkflow`)
  const graph = JSON.parse(read('../public/workflows/video_ltx2_3_ia2v.json'))
  const output = modify(graph, { duration: 3, fps: 24, width: 1920, height: 1080, audioStartSeconds: 32, inputAudio: 'song.wav', inputImage: 'shot.png' })
  assert.equal(output['340:331'].inputs.value, 3)
  assert.equal(output['340:323'].inputs.value, 24)
  assert.equal(output['340:330'].inputs.value, 1920)
  assert.equal(output['340:324'].inputs.value, 1080)
  assert.equal(output['340:332'].inputs.start_index, 32)
  assert.deepEqual(plain(output['340:332'].inputs.duration), ['340:331', 0])
  assert.equal(graph['340:332'].inputs.start_index, 0, 'original graph is unchanged')
  assert.equal(modify(graph, { duration: 3, audioStartSeconds: 32.5 })['340:332'].inputs.start_index, 32.5)
  assert.throws(() => modify(graph, { audioStartSeconds: -1 }), /non-negative/)
  delete graph['340:332']
  assert.throws(() => modify(graph, { audioStartSeconds: 32 }), /no verified/)
})

test('waiting frame jobs use a captured File snapshot, never a later staged shot; ledger omits File', () => {
  const file = makeFrame().file
  const baseJob = { inputFromTimelineFrame: true }
  const frozenExpression = generate.match(/timelineFrameFile: baseJob\.inputFromTimelineFrame[^\n]+/)[0].replace(/^timelineFrameFile: /, '').replace(/,$/, '')
  const job = { inputFromTimelineFrame: true, timelineFrameFile: vm.runInNewContext(frozenExpression, {
    baseJob, useFrameForAIStore: { getState: () => ({ frame: { file } }) } }) }
  const upload = between(generate, 'if (job.inputFromTimelineFrame) {', '        } else {') + '\n}'
  const input = vm.runInNewContext(`let fileToUpload; ${upload}; fileToUpload`, { job })
  assert.equal(input, file)
  assert.throws(() => vm.runInNewContext(`let fileToUpload; ${upload}`, { job: { inputFromTimelineFrame: true } }), /Stage and queue/)
  const sanitize = between(generate, 'function sanitizeGenerationJobForStorage(', 'function normalizePersistedGenerationJob(')
  const stored = vm.runInNewContext(`${sanitize}; sanitizeGenerationJobForStorage(job)`, {
    job: { ...job, id: 'job-1' }, sanitizeProjectOriginForStorage: () => null })
  assert.equal(stored.timelineFrameFile, undefined)
})

const require = createRequire(import.meta.url)
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const { transformSync } = require('esbuild')
function renderWorkflowField(field, values, workflowId = 'ltx23-ia2v') {
  const writes = []
  const module = { exports: {} }
  const code = transformSync(read('../src/components/generate/WorkflowFieldRenderer.jsx'), { loader: 'jsx', format: 'cjs' }).code
  vm.runInNewContext(code, { module, exports: module.exports, React, require: name => {
    if (name === 'react') return { ...React, useMemo: callback => callback() }
    if (name.endsWith('/assetsStore')) return { __esModule: true, default: () => ({ assets: [audioAsset], folders: [] }) }
    if (name.endsWith('/generationHandoff.mjs')) return handoff
    if (name.endsWith('/musicGenerationModels.mjs')) return musicModels
    return require(name)
  } })
  const element = module.exports.default({ field, values, workflow: { workflowId }, actions: { setValue: (...args) => writes.push(args) } })
  return { element, html: renderToStaticMarkup(element), writes }
}
const descendants = node => !node || typeof node !== 'object' ? [] : [node, ...React.Children.toArray(node.props?.children).flatMap(descendants)]

test('live workflow-detail duration widget renders explicit 3s and accepts custom seconds, without changing non-LTX controls', () => {
  const field = { id: 'duration', type: 'duration', label: 'Duration' }
  const rendered = renderWorkflowField(field, { duration: 3 })
  assert.match(rendered.html, /Generation duration seconds/)
  assert.match(rendered.html, /value="3"/)
  assert.match(rendered.html, /buttons above are presets/)
  const input = descendants(rendered.element).find(node => node.type === 'input')
  input.props.onChange({ target: { value: '4' } })
  assert.deepEqual(rendered.writes, [['duration', 4]])
  input.props.onChange({ target: { value: '0' } })
  assert.equal(rendered.writes.length, 1)
  assert.doesNotMatch(renderWorkflowField(field, { duration: 3 }, 'wan22-i2v').html, /Generation duration seconds/)
})

test('Generate YuE2 length widget defaults to Automatic and reveals only a bounded custom maximum', () => {
  const field = { id: 'musicLengthMode', type: 'yue2Length', label: 'Song length' }
  const automatic = renderWorkflowField(field, { musicLengthMode: 'automatic', musicDuration: 30 }, 'music-gen-yue2')
  assert.match(automatic.html, /Automatic/)
  assert.match(automatic.html, /Custom maximum/)
  assert.doesNotMatch(automatic.html, /type="number"/)
  const selector = descendants(automatic.element).find(node => typeof node.type === 'function')
  selector.props.onChange('custom')
  assert.deepEqual(automatic.writes, [['musicLengthMode', 'custom']])
  const custom = renderWorkflowField(field, { musicLengthMode: 'custom', musicDuration: 300 }, 'music-gen-yue2')
  assert.match(custom.html, /min="5" max="360"/)
  assert.match(custom.html, /value="300"/)
  const input = descendants(custom.element).find(node => node.type === 'input')
  for (const value of ['', '3', '30', '300']) input.props.onChange({ target: { value } })
  assert.deepEqual(custom.writes, [['musicDuration', ''], ['musicDuration', 3], ['musicDuration', 30], ['musicDuration', 300]], 'typing a new maximum is not blocked by intermediate digits')
  for (const value of ['0', '4', '361', '360', '300']) input.props.onBlur({ target: { value } })
  assert.deepEqual(custom.writes.slice(4), [['musicDuration', 5], ['musicDuration', 5], ['musicDuration', 360], ['musicDuration', 360], ['musicDuration', 300]])
  const ace = renderWorkflowField({ id: 'musicDuration', type: 'musicDuration', label: 'Duration' }, { musicDuration: 30 }, 'music-gen')
  assert.doesNotMatch(ace.html, /Automatic|Custom maximum|360/)
  assert.match(ace.html, /120s/)
})

test('live audio selector displays actual source32–35s and never claims the timeline song was matched', () => {
  const conditioningAudio = handoff.describeConditioningAudio({ workflowId: request.workflowId, asset: audioAsset, duration: 3, frame: makeFrame() })
  const rendered = renderWorkflowField({ id: 'audioAsset', type: 'assetSelect', assetType: 'audio' }, { audioAsset, conditioningAudio })
  assert.match(rendered.html, /Conditioning source: 32s–35s/)
  assert.match(rendered.html, /Not automatically matched to timeline audio/)
})

const { createComfyStudioMcpServer } = require('../electron/mcpServer.js')
const body = result => JSON.parse(result.content[0].text)
const snapshot = { project: { name: 'Synthetic project' }, assets: [audioAsset], currentTimeline: {
  id: 'timeline-1', fps: 24, width: 1920, height: 1080, playheadPosition: 32,
  tracks: [{ id: 'v1', type: 'video' }], clips: [{ id: 'shot-10', trackId: 'v1', type: 'image', start: 32, duration: 3 }], selectedClipIds: ['shot-10'] } }

test('native preparation preview keeps 3s and explicit audio range; apply forwards only verified source settings', async () => {
  const calls = []
  const server = createComfyStudioMcpServer({ performAction: async action => { calls.push(action); return { success: true } } })
  const preview = body(await server.prepareGenerationFromTimelineContext(snapshot, request))
  assert.equal(preview.plan.generationSettings.durationSeconds, 3)
  assert.equal(preview.plan.conditioningAudio.startSeconds, 32)
  assert.equal(calls.length, 0)
  await server.prepareGenerationFromTimelineContext(snapshot, { ...request, previewOnly: false })
  assert.equal(calls[0].payload.durationSeconds, 3)
  assert.equal(calls[0].payload.audioAssetId, 'song')
  assert.equal(calls[0].payload.audioStartSeconds, 32)
  assert.equal((await server.prepareGenerationFromTimelineContext(snapshot, { ...request, audioStartSeconds: 119 })).isError, true)
  assert.equal(calls.length, 1)
})

test('native prepared queue schema advertises exact review; direct apply cannot bypass it', async () => {
  const calls = []
  const suggested = { previewOnly: false, previewToken: 'synthetic-token', expectedContext: { revision: 1 }, requireTimelineFrame: true }
  const server = createComfyStudioMcpServer({ performAction: async action => { calls.push(action); return { suggestedApplyPayload: suggested } } })
  const schema = server.tools.find(tool => tool.name === 'queue_prepared_generation').inputSchema
  assert.equal(schema.properties.previewToken.type, 'string')
  assert.equal((await server.queuePreparedGeneration(snapshot, { previewOnly: false })).isError, true)
  assert.equal(calls.length, 0)
  assert.equal((await server.queuePreparedGeneration(snapshot, { previewOnly: false, previewToken: 'synthetic-token' })).isError, true)
  const preview = body(await server.queuePreparedGeneration(snapshot))
  assert.deepEqual(preview.suggestedApplyCall.arguments, suggested)
  await server.queuePreparedGeneration(snapshot, suggested)
  assert.deepEqual(calls[1].payload.expectedContext, suggested.expectedContext)
  assert.equal(calls[1].payload.previewToken, 'synthetic-token')
})
