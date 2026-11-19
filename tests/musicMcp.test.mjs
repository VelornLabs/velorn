import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import {
  MUSIC_KEY_SCALES,
  MUSIC_TIME_SIGNATURES,
  MUSIC_VARIATIONS_MAX,
  getMusicBackend,
  getMusicCompletion,
  normalizeMusicBackend,
  normalizeMusicBpm,
  resolveMusicLength,
  YUE2_AUTOMATIC_DURATION,
  YUE2_CUSTOM_DURATION_MAX,
} from '../src/services/musicGenerationModels.mjs'

const require = createRequire(import.meta.url)
const { createComfyStudioMcpServer } = require('../electron/mcpServer.js')
const source = fs.readFileSync(new URL('../src/services/mcpActions.js', import.meta.url), 'utf8')
const start = source.indexOf('async function handleGenerateMusic(')
const end = source.indexOf('async function handleQueuePromptGenerationBatch(', start)
assert.ok(start >= 0 && end > start, 'actual renderer music handlers must be present')

// Exercise the actual renderer handlers without loading React, starting
// Electron, touching a user project, or connecting to ComfyUI. Only their
// external store/queue dependencies are replaced; model normalization is real.
function createHarness({ project = true, jobs = [], assets = [], queueError = null } = {}) {
  const calls = { queue: [], refresh: 0, requestedIds: [] }
  const handlers = vm.runInNewContext(`${source.slice(start, end)}\n({ handleGenerateMusic, handleGetMusicGenerationStatus })`, {
    MUSIC_KEY_SCALES,
    MUSIC_TIME_SIGNATURES,
    MUSIC_VARIATIONS_MAX,
    getMusicBackend,
    normalizeMusicBackend,
    normalizeMusicBpm,
    resolveMusicLength,
    YUE2_AUTOMATIC_DURATION,
    YUE2_CUSTOM_DURATION_MAX,
    useProjectStore: { getState: () => project ? {
      currentProject: { id: 'project-1', name: 'Synthetic music test' },
      currentProjectHandle: '/synthetic/velorn-music-test',
    } : { currentProject: { id: 'unsaved' }, currentProjectHandle: null } },
    useAssetsStore: { getState: () => ({ getAssetById: id => assets.find(asset => asset.id === id) }) },
    summarizeAsset: asset => ({ id: asset.id, name: asset.name, type: asset.type, duration: asset.duration }),
    queueMusicGeneration: async params => {
      calls.queue.push(params)
      if (queueError) throw queueError
      return [{ promptId: 'music-test-1', backend: params.backend, status: 'queued' }]
    },
    refreshMusicJobs: async () => { calls.refresh += 1 },
    getMusicJobs: ids => {
      calls.requestedIds.push(ids)
      return ids ? jobs.filter(job => ids.includes(job.promptId)) : jobs
    },
  })
  return { ...handlers, calls }
}

const toPlain = value => JSON.parse(JSON.stringify(value))

test('legacy music preview defaults to ACE-Step with exact duration and musical controls', async () => {
  const harness = createHarness({ project: false })
  const result = await harness.handleGenerateMusic({ tags: 'warm piano' })
  assert.equal(result.previewOnly, true)
  assert.equal(result.plan.backend, 'ace-step')
  assert.equal(result.plan.durationMode, 'exact')
  assert.equal(result.plan.lengthMode, 'exact')
  assert.equal(result.plan.workflowId, getMusicBackend('ace-step').workflowId)
  assert.equal(result.plan.durationSeconds, 30)
  assert.equal(result.plan.bpm, 120)
  assert.equal(result.plan.keyScale, 'C major')
  assert.equal(result.plan.timeSignature, '4')
  assert.equal(result.plan.instrumental, true)
  assert.equal(result.plan.seed, null, 'an omitted seed remains random, not zero')
  assert.equal(result.suggestedApplyPayload.previewOnly, false)
  assert.equal('lengthMode' in result.suggestedApplyPayload, false, 'internal exact mode must not leak into ACE-Step inputs')
  assert.equal(result.suggestedApplyPayload.durationSeconds, 30)
  assert.equal(harness.calls.queue.length, 0)
  assert.equal(harness.calls.refresh, 0)
})

test('old explicit-duration YuE 2 preview stays Custom and identifies best-effort instrumental without ACE controls', async () => {
  const harness = createHarness({ project: false })
  const result = await harness.handleGenerateMusic({ backend: 'yue2', tags: 'quiet strings', durationSeconds: 75 })
  assert.equal(result.plan.backend, 'yue2')
  assert.equal(result.plan.workflowId, getMusicBackend('yue2').workflowId)
  assert.equal(result.plan.durationMode, 'maximum')
  assert.equal(result.plan.lengthMode, 'custom')
  assert.equal(result.plan.durationSeconds, 75)
  assert.match(result.message, /up to 75s/)
  assert.match(result.message, /may finish earlier/)
  assert.match(result.plan.notes.join(' '), /best effort/)
  assert.match(result.plan.notes.join(' '), /measured duration/)
  for (const key of ['bpm', 'keyScale', 'timeSignature', 'language']) assert.equal(key in result.plan, false)
  assert.equal(harness.calls.queue.length, 0)
})

test('YuE 2 previews default to Automatic with a visible safety limit and freeze that choice without queueing', async () => {
  for (const extra of [{}, { lyrics: '[verse]\nWords do not select a hidden mode' }, { lengthMode: 'automatic' }, { lengthMode: 'automatic', durationSeconds: 360 }]) {
    const harness = createHarness({ project: false })
    const result = await harness.handleGenerateMusic({ backend: 'yue2', tags: 'quiet strings', ...extra })
    assert.equal(result.previewOnly, true)
    assert.equal(result.plan.lengthMode, 'automatic')
    assert.equal(result.plan.durationMode, 'maximum')
    assert.equal(result.plan.durationSeconds, 360)
    assert.match(result.message, /Automatic.*up to 360s safety limit/)
    assert.match(result.plan.notes.join(' '), /does not guarantee a complete ending/)
    assert.equal(result.suggestedApplyPayload.backend, 'yue2')
    assert.equal(result.suggestedApplyPayload.lengthMode, 'automatic')
    assert.equal(result.suggestedApplyPayload.durationSeconds, 360)
    assert.equal(result.suggestedApplyPayload.previewOnly, false)
    assert.equal(harness.calls.queue.length, 0)
    assert.equal(harness.calls.refresh, 0)
  }
})

test('YuE 2 Custom maximum accepts both range endpoints and remains explicit in the approved call', async () => {
  for (const durationSeconds of [5, 90, 240, 360]) {
    const harness = createHarness()
    const preview = await harness.handleGenerateMusic({ backend: 'yue2', tags: 'piano', lengthMode: 'custom', durationSeconds })
    assert.equal(preview.plan.lengthMode, 'custom')
    assert.equal(preview.plan.durationSeconds, durationSeconds)
    assert.match(preview.message, /Custom maximum/)
    assert.equal(preview.suggestedApplyPayload.lengthMode, 'custom')
    const applied = await harness.handleGenerateMusic(preview.suggestedApplyPayload)
    assert.equal(applied.lengthMode, 'custom')
    assert.equal(applied.durationSeconds, durationSeconds)
    assert.equal(harness.calls.queue[0].lengthMode, 'custom')
    assert.equal(harness.calls.queue[0].durationSeconds, durationSeconds)
  }
})

test('invalid explicit YuE 2 modes or limits fail preview and apply before any queue call', async () => {
  const invalid = [
    ...['', 'exact', 'AUTO', null, 1, {}].map(lengthMode => ({ lengthMode })),
    ...[undefined, null, 0, 4.9, 361, Infinity, NaN, '30', {}].map(durationSeconds => ({ lengthMode: 'custom', durationSeconds })),
    ...[null, 30, 359, 361, '360'].map(durationSeconds => ({ lengthMode: 'automatic', durationSeconds })),
  ]
  for (const args of invalid) {
    for (const previewOnly of [true, false]) {
      const harness = createHarness()
      await assert.rejects(harness.handleGenerateMusic({ backend: 'yue2', tags: 'piano', ...args, previewOnly }), /lengthMode|durationSeconds|safety limit/)
      assert.equal(harness.calls.queue.length, 0)
      assert.equal(harness.calls.refresh, 0)
    }
  }
})

test('ACE-Step rejects explicit YuE 2 length modes instead of ignoring them', async () => {
  for (const backend of [undefined, 'ace-step']) {
    for (const lengthMode of ['automatic', 'custom', 'exact', null]) {
      for (const previewOnly of [true, false]) {
        const harness = createHarness()
        await assert.rejects(harness.handleGenerateMusic({ backend, tags: 'piano', lengthMode, durationSeconds: 30, previewOnly }), /only for YuE 2.*omit lengthMode/)
        assert.equal(harness.calls.queue.length, 0)
      }
    }
  }
})

test('explicit unsupported YuE 2 controls are rejected during preview and apply, even at defaults', async () => {
  for (const [key, value] of Object.entries({ bpm: 120, keyScale: 'C major', timeSignature: '4', language: 'en' })) {
    for (const previewOnly of [true, false]) {
      const harness = createHarness()
      await assert.rejects(harness.handleGenerateMusic({ backend: 'yue2', tags: 'warm piano', [key]: value, previewOnly }), new RegExp(key))
      assert.equal(harness.calls.queue.length, 0)
    }
  }
})

test('unknown or malformed explicit backends are rejected before queueing', async () => {
  for (const backend of ['unknown', '', null, 1, {}, 'YuE2']) {
    const harness = createHarness()
    await assert.rejects(harness.handleGenerateMusic({ backend, tags: 'warm piano', previewOnly: false }), /Unknown music backend/)
    assert.equal(harness.calls.queue.length, 0)
  }
})

test('queueing either backend requires an open saved project', async () => {
  for (const backend of ['ace-step', 'yue2']) {
    const harness = createHarness({ project: false })
    await assert.rejects(harness.handleGenerateMusic({ backend, tags: 'warm piano', previewOnly: false }), /saved Velorn project/)
    assert.equal(harness.calls.queue.length, 0)
  }
})

test('legacy approved queue still sends ACE-Step controls', async () => {
  const harness = createHarness()
  const result = await harness.handleGenerateMusic({ tags: 'warm piano', bpm: 85, keyScale: 'A minor', timeSignature: '3', previewOnly: false })
  assert.equal(result.success, true)
  assert.equal(result.backend, 'ace-step')
  assert.equal(result.durationMode, 'exact')
  assert.equal(result.lengthMode, 'exact')
  assert.equal(result.durationSeconds, 30)
  assert.deepEqual(toPlain(result.promptIds), ['music-test-1'])
  const [queued] = harness.calls.queue
  assert.equal(queued.backend, 'ace-step')
  assert.equal(queued.lengthMode, 'exact')
  assert.equal(queued.bpm, 85)
  assert.equal(queued.keyScale, 'A minor')
  assert.equal(queued.timeSignature, '3')
})

test('approved YuE 2 queue forwards lyrics and maximum duration without invented musical controls', async () => {
  const harness = createHarness()
  const result = await harness.handleGenerateMusic({ backend: 'yue2', tags: 'soul', lyrics: '[verse]\nA synthetic test', durationSeconds: 90, seed: 0, variations: 2, previewOnly: false })
  assert.equal(result.success, true)
  assert.equal(result.backend, 'yue2')
  assert.equal(result.durationMode, 'maximum')
  assert.equal(result.lengthMode, 'custom')
  const [queued] = harness.calls.queue
  assert.equal(queued.backend, 'yue2')
  assert.equal(queued.lengthMode, 'custom')
  assert.equal(queued.durationSeconds, 90)
  assert.equal(queued.seed, 0)
  assert.equal(queued.variations, 2)
  assert.equal(queued.instrumental, false)
  assert.match(queued.lyrics, /synthetic test/)
  for (const key of ['bpm', 'keyScale', 'timeSignature', 'language']) assert.equal(key in queued, false)
})

test('an explicit instrumental request clears supplied lyrics for both backends', async () => {
  for (const backend of ['ace-step', 'yue2']) {
    const harness = createHarness()
    await harness.handleGenerateMusic({ backend, tags: 'piano', lyrics: 'Do not sing these words', instrumental: true, previewOnly: false })
    assert.equal(harness.calls.queue[0].lyrics, '')
    assert.equal(harness.calls.queue[0].instrumental, true)
  }
})

test('partial queue failures expose accepted prompt ids instead of hiding or retrying them', async () => {
  const error = Object.assign(new Error('ComfyUI disconnected'), {
    queuedJobs: [{ promptId: 'accepted-1', backend: 'yue2', status: 'queued' }],
  })
  const harness = createHarness({ queueError: error })
  const result = await harness.handleGenerateMusic({ backend: 'yue2', tags: 'piano', variations: 3, previewOnly: false })
  assert.equal(result.success, true)
  assert.equal(result.partial, true)
  assert.deepEqual(toPlain(result.promptIds), ['accepted-1'])
  assert.match(result.warning, /Only 1 of 3/)
  assert.match(result.warning, /ComfyUI disconnected/)
  assert.match(result.warning, /before retrying/)
  assert.equal(harness.calls.queue.length, 1)
})

test('queue failure with no accepted jobs remains an error', async () => {
  const error = Object.assign(new Error('Missing YuE 2 model'), { queuedJobs: [] })
  const harness = createHarness({ queueError: error })
  await assert.rejects(harness.handleGenerateMusic({ backend: 'yue2', tags: 'piano', previewOnly: false }), /Missing YuE 2 model/)
  assert.equal(harness.calls.queue.length, 1)
})

test('older explicit-duration calls preserve clamping with backend-specific limits and variation bounds', async () => {
  const harness = createHarness()
  const short = await harness.handleGenerateMusic({ backend: 'yue2', tags: 'piano', durationSeconds: 1, variations: -2 })
  assert.equal(short.plan.durationSeconds, 5)
  assert.equal(short.plan.lengthMode, 'custom')
  assert.equal(short.plan.variations, 1)
  const long = await harness.handleGenerateMusic({ backend: 'yue2', tags: 'piano', durationSeconds: 999, variations: 99 })
  assert.equal(long.plan.durationSeconds, 360)
  assert.equal(long.plan.lengthMode, 'custom')
  assert.equal(long.plan.variations, 4)
  for (const backend of [undefined, 'ace-step']) {
    const ace = await harness.handleGenerateMusic({ backend, tags: 'piano', durationSeconds: 999 })
    assert.equal(ace.plan.durationSeconds, 240)
    assert.equal(ace.plan.lengthMode, 'exact')
  }
  for (const durationSeconds of [null, 0, '30']) {
    const old = await harness.handleGenerateMusic({ backend: 'yue2', tags: 'piano', durationSeconds })
    assert.equal(old.plan.lengthMode, 'custom', 'explicit legacy values must not become Automatic')
    assert.equal(old.plan.durationSeconds, durationSeconds === '30' ? 30 : 5)
  }
  const alias = await harness.handleGenerateMusic({ backend: 'yue2', tags: 'piano', duration: 90 })
  assert.equal(alias.plan.lengthMode, 'custom')
  assert.equal(alias.plan.durationSeconds, 90)
})

test('music status preserves backend, duration mode and actual measured duration without substituting requested maximum', async () => {
  const params = { backend: 'yue2', lengthMode: 'custom', durationSeconds: 90 }
  const completion = getMusicCompletion(params, 42.3)
  const harness = createHarness({
    jobs: [{ promptId: 'yue-job', ...params, durationMode: 'maximum', measuredDurationSeconds: 42.3,
      completion, completionWarning: completion.warning, status: 'completed', assetIds: ['audio-1', 'missing'] },
      { promptId: 'ace-job', backend: 'ace-step', durationMode: 'exact', status: 'queued', assetIds: [] }],
    assets: [{ id: 'audio-1', name: 'YuE 2 take', type: 'audio', duration: 42.3 }],
  })
  const result = await harness.handleGetMusicGenerationStatus({ promptIds: [' yue-job ', ''] })
  assert.equal(harness.calls.refresh, 1)
  assert.deepEqual(toPlain(harness.calls.requestedIds), [['yue-job']])
  assert.equal(result.jobCount, 1)
  assert.equal(result.jobs[0].backend, 'yue2')
  assert.equal(result.jobs[0].durationMode, 'maximum')
  assert.equal(result.jobs[0].lengthMode, 'custom')
  assert.equal(result.jobs[0].durationSeconds, 90)
  assert.equal(result.jobs[0].measuredDurationSeconds, 42.3)
  assert.equal(result.jobs[0].completion.status, 'unknown')
  assert.equal(result.jobs[0].completion.naturalEndingVerified, false)
  assert.equal(result.jobs[0].completion.truncated, null)
  assert.equal(result.jobs[0].completionWarning, null)
  assert.equal(result.jobs[0].assets.length, 1)
  assert.equal(result.jobs[0].assets[0].duration, 42.3)
  assert.equal(harness.calls.queue.length, 0)
})

test('music status forwards measured Automatic limit warnings without claiming a verified ending', async () => {
  const params = { backend: 'yue2', lengthMode: 'automatic', durationSeconds: 360 }
  const completion = getMusicCompletion(params, 359.95)
  const harness = createHarness({
    jobs: [{ promptId: 'auto-job', ...params, durationMode: 'maximum', measuredDurationSeconds: 359.95,
      completion, completionWarning: completion.warning, status: 'completed', assetIds: ['auto-audio'] }],
    assets: [{ id: 'auto-audio', name: 'Automatic take', type: 'audio', duration: 359.95 }],
  })
  const result = await harness.handleGetMusicGenerationStatus()
  const [job] = result.jobs
  assert.equal(job.lengthMode, 'automatic')
  assert.equal(job.durationSeconds, 360)
  assert.equal(job.measuredDurationSeconds, 359.95)
  assert.equal(job.assets[0].duration, 359.95)
  assert.equal(job.completion.status, 'limit-reached')
  assert.equal(job.completion.basis, 'measured-duration')
  assert.equal(job.completion.naturalEndingVerified, false)
  assert.equal(job.completion.truncated, null)
  assert.match(job.completionWarning, /360-second limit.*may be unfinished/)
  assert.equal(harness.calls.queue.length, 0)
})

test('public music schema advertises explicit backend selection and honest YuE 2 duration/control limits', () => {
  const server = createComfyStudioMcpServer()
  const generation = server.tools.find(tool => tool.name === 'generate_music')
  const status = server.tools.find(tool => tool.name === 'get_music_generation_status')
  assert.deepEqual(generation.inputSchema.properties.backend.enum, ['ace-step', 'yue2'])
  assert.deepEqual(generation.inputSchema.required, ['tags'])
  assert.match(generation.inputSchema.properties.backend.description, /Omitted means ace-step/)
  assert.deepEqual(generation.inputSchema.properties.lengthMode.enum, ['automatic', 'custom'])
  assert.equal(generation.inputSchema.properties.lengthMode.default, undefined)
  assert.equal(generation.inputSchema.properties.durationSeconds.default, undefined)
  assert.equal(generation.inputSchema.properties.durationSeconds.maximum, 360)
  assert.match(generation.inputSchema.properties.lengthMode.description, /rejected for ace-step/)
  assert.match(generation.description, /360-second safety limit/)
  assert.match(generation.inputSchema.properties.durationSeconds.description, /maximum/)
  assert.match(generation.inputSchema.properties.instrumental.description, /best effort/)
  assert.match(generation.inputSchema.properties.bpm.description, /Rejected for yue2/)
  assert.match(status.description, /measured audio duration/)
  assert.match(status.description, /frozen lengthMode/)
  assert.match(status.description, /not a verified end-of-song/)
})

test('music status preserves awaiting-project ownership without inventing imported assets or duration', async () => {
  const params = { backend: 'yue2', lengthMode: 'automatic', durationSeconds: 360 }
  const completion = getMusicCompletion(params, null)
  const harness = createHarness({ jobs: [{ promptId: 'waiting', ...params, durationMode: 'maximum',
    completion, completionWarning: completion.warning,
    status: 'awaiting-project', belongsToCurrentProject: false, measuredDurationSeconds: null, assetIds: [] }] })
  const result = await harness.handleGetMusicGenerationStatus()
  assert.equal(result.jobs[0].status, 'awaiting-project')
  assert.equal(result.jobs[0].belongsToCurrentProject, false)
  assert.equal(result.jobs[0].measuredDurationSeconds, null)
  assert.equal(result.jobs[0].lengthMode, 'automatic')
  assert.equal(result.jobs[0].durationSeconds, 360)
  assert.equal(result.jobs[0].completion.status, 'unknown')
  assert.equal(result.jobs[0].completion.naturalEndingVerified, false)
  assert.equal(result.jobs[0].completionWarning, null)
  assert.deepEqual(toPlain(result.jobs[0].assets), [])
})

test('public music bridge defaults to read-only preview, then routes an explicit approved YuE 2 queue', async () => {
  const harness = createHarness()
  const server = createComfyStudioMcpServer({ performAction: async ({ action, payload }) => {
    assert.equal(action, 'generate_music')
    return harness.handleGenerateMusic(payload)
  } })
  server.updateSnapshot({ project: { id: 'project-1', name: 'Synthetic test', path: '/synthetic/project' }, assets: [], timelines: [], currentTimeline: null })
  const preview = await server.callTool('generate_music', { backend: 'yue2', tags: 'warm piano' })
  assert.equal(preview.isError, undefined)
  const body = JSON.parse(preview.content[0].text)
  assert.equal(body.previewOnly, true)
  assert.equal(body.result.plan.backend, 'yue2')
  assert.equal(body.result.plan.lengthMode, 'automatic')
  assert.equal(body.result.plan.durationSeconds, 360)
  assert.equal(body.suggestedApplyCall.arguments.lengthMode, 'automatic')
  assert.equal(body.suggestedApplyCall.arguments.durationSeconds, 360)
  assert.equal(harness.calls.queue.length, 0)
  const apply = await server.callTool('generate_music', body.suggestedApplyCall.arguments)
  assert.equal(apply.isError, undefined)
  assert.equal(harness.calls.queue.length, 1)
  assert.equal(harness.calls.queue[0].backend, 'yue2')
  assert.equal(harness.calls.queue[0].lengthMode, 'automatic')
  assert.equal(harness.calls.queue[0].durationSeconds, 360)
})

test('public music bridge preserves legacy ACE-Step and explicit YuE 2 durations across preview and apply', async () => {
  for (const request of [{ tags: 'piano', durationSeconds: 45 }, { backend: 'ace-step', tags: 'piano', durationSeconds: 240 }, { backend: 'yue2', tags: 'piano', durationSeconds: 90 }]) {
    const harness = createHarness()
    const server = createComfyStudioMcpServer({ performAction: async ({ payload }) => harness.handleGenerateMusic(payload) })
    server.updateSnapshot({ project: { id: 'project-1', name: 'Synthetic test' }, assets: [] })
    const preview = await server.callTool('generate_music', request)
    assert.equal(preview.isError, undefined)
    const body = JSON.parse(preview.content[0].text)
    const expectedMode = request.backend === 'yue2' ? 'custom' : 'exact'
    assert.equal(body.result.plan.lengthMode, expectedMode)
    assert.equal(body.result.plan.durationSeconds, request.durationSeconds)
    assert.equal(harness.calls.queue.length, 0)
    const applied = await server.callTool('generate_music', body.suggestedApplyCall.arguments)
    assert.equal(applied.isError, undefined)
    assert.equal(harness.calls.queue[0].lengthMode, expectedMode)
    assert.equal(harness.calls.queue[0].durationSeconds, request.durationSeconds)
  }
})

test('public music bridge surfaces unsupported YuE 2 controls as errors without queueing', async () => {
  const harness = createHarness()
  const server = createComfyStudioMcpServer({ performAction: async ({ payload }) => harness.handleGenerateMusic(payload) })
  server.updateSnapshot({ project: { id: 'project-1', name: 'Synthetic test' }, assets: [] })
  const result = await server.callTool('generate_music', { backend: 'yue2', tags: 'piano', bpm: 120, previewOnly: false })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /bpm/)
  assert.equal(harness.calls.queue.length, 0)
})
