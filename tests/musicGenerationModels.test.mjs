import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import {
  ACE_STEP_MODELS,
  YUE2_MODEL,
  MUSIC_BACKENDS,
  MUSIC_DURATION_MIN,
  MUSIC_DURATION_MAX,
  MUSIC_VARIATIONS_MAX,
  MUSIC_BPM_MIN,
  MUSIC_BPM_MAX,
  MUSIC_TIME_SIGNATURES,
  MUSIC_KEY_SCALES,
  normalizeMusicBackend,
  getMusicBackend,
  normalizeMusicDuration,
  resolveMusicLength,
  getMusicCompletion,
  YUE2_AUTOMATIC_DURATION,
  YUE2_CUSTOM_DURATION_MAX,
  normalizeMusicBpm,
  buildAceStepWorkflow,
  buildYue2Workflow,
} from '../src/services/musicGenerationModels.mjs'

test('legacy model selections remain ACE-Step and unknown backends fail closed', () => {
  for (const value of [undefined, null, '']) assert.equal(normalizeMusicBackend(value), 'ace-step')
  for (const value of ['yue2', 'ace-step']) assert.equal(normalizeMusicBackend(value), value)
  for (const value of ['other', 'YuE2', 'music-gen', {}, true, 1, ' ']) {
    assert.throws(() => normalizeMusicBackend(value), /Unknown music model/)
  }
})

test('backend descriptors retain distinct workflow identities and stable saver IDs', () => {
  assert.equal(MUSIC_BACKENDS.length, 2)
  assert.equal(getMusicBackend().workflowId, 'music-gen')
  assert.equal(getMusicBackend('ace-step').durationMode, 'exact')
  assert.deepEqual(getMusicBackend('ace-step').modelFiles, Object.values(ACE_STEP_MODELS))
  assert.equal(getMusicBackend('yue2').workflowId, 'music-gen-yue2')
  assert.equal(getMusicBackend('yue2').durationMode, 'maximum')
  assert.deepEqual(getMusicBackend('yue2').modelFiles, [YUE2_MODEL])
  for (const descriptor of MUSIC_BACKENDS) {
    assert.equal(descriptor.outputNodeId, '107')
    assert.ok(Object.isFrozen(descriptor))
    assert.ok(Object.isFrozen(descriptor.modelFiles))
  }
  assert.ok(Object.isFrozen(MUSIC_BACKENDS))
})

test('shared normalization preserves guided music limits and legacy fallbacks', () => {
  assert.equal(MUSIC_DURATION_MIN, 5)
  assert.equal(MUSIC_DURATION_MAX, 240)
  assert.equal(MUSIC_VARIATIONS_MAX, 4)
  assert.equal(normalizeMusicDuration(-10), 5)
  assert.equal(normalizeMusicDuration(1000), 240)
  assert.equal(normalizeMusicDuration('13.6'), 14)
  assert.equal(normalizeMusicDuration(undefined), 30)
  assert.equal(normalizeMusicDuration(NaN), 30)
  assert.equal(normalizeMusicDuration(Infinity), 30)
  assert.equal(normalizeMusicBpm(-10), MUSIC_BPM_MIN)
  assert.equal(normalizeMusicBpm(1000), MUSIC_BPM_MAX)
  assert.equal(normalizeMusicBpm('89.6'), 90)
  assert.equal(normalizeMusicBpm(undefined), 120)
  assert.deepEqual(MUSIC_TIME_SIGNATURES, ['2', '3', '4', '6'])
  assert.ok(MUSIC_KEY_SCALES.includes('C major'))
})

test('ACE-Step graph stays compatible with the existing bundled workflow', () => {
  const bundled = JSON.parse(fs.readFileSync(new URL('../public/workflows/music_generation.json', import.meta.url), 'utf8'))
  const conditioning = bundled['94'].inputs
  const graph = buildAceStepWorkflow({
    tags: conditioning.tags,
    lyrics: conditioning.lyrics,
    durationSeconds: conditioning.duration,
    seed: conditioning.seed,
    bpm: conditioning.bpm,
    keyScale: conditioning.keyscale,
    timeSignature: conditioning.timesignature,
    language: conditioning.language,
  })
  assert.deepEqual(Object.keys(graph), Object.keys(bundled))
  for (const [id, node] of Object.entries(graph)) {
    assert.equal(node.class_type, bundled[id].class_type)
    const expected = { ...bundled[id].inputs }
    if (id === '107') {
      expected.filename_prefix = 'audio/velorn_music_ace'
      expected.audioUI = ''
    }
    assert.deepEqual(node.inputs, expected, `legacy node ${id}`)
  }
})

test('YuE2 defaults to Automatic while existing explicit maxima remain custom', () => {
  assert.equal(YUE2_AUTOMATIC_DURATION, 360)
  assert.equal(YUE2_CUSTOM_DURATION_MAX, 360)
  assert.deepEqual(resolveMusicLength({ backend: 'yue2' }), { lengthMode: 'automatic', durationSeconds: 360 })
  assert.deepEqual(resolveMusicLength({ backend: 'yue2', lengthMode: 'automatic', durationSeconds: 45 }), { lengthMode: 'automatic', durationSeconds: 360 })
  assert.deepEqual(resolveMusicLength({ backend: 'yue2', durationSeconds: 45 }), { lengthMode: 'custom', durationSeconds: 45 })
  assert.deepEqual(resolveMusicLength({ backend: 'yue2', lengthMode: 'custom', durationSeconds: 310 }), { lengthMode: 'custom', durationSeconds: 310 })
  assert.deepEqual(resolveMusicLength({}), { lengthMode: 'exact', durationSeconds: 30 })
  assert.deepEqual(resolveMusicLength({ backend: 'ace-step', durationSeconds: 310 }), { lengthMode: 'exact', durationSeconds: 240 })
  assert.throws(() => resolveMusicLength({ backend: 'ace-step', lengthMode: 'automatic' }), /YuE2 only/)
  assert.throws(() => resolveMusicLength({ backend: 'yue2', lengthMode: 'exact' }), /automatic or custom song length/i)
  assert.equal(buildYue2Workflow()['95'].inputs.max_duration, 360)
})

test('YuE2 completion warns at the ceiling without claiming a verified natural ending', () => {
  for (const seconds of [359.9, 360, 360.04]) {
    const completion = getMusicCompletion({ backend: 'yue2', lengthMode: 'automatic' }, seconds)
    assert.equal(completion.status, 'limit-reached')
    assert.equal(completion.basis, 'measured-duration')
    assert.equal(completion.limitSeconds, 360)
    assert.match(completion.warning, /360-second limit.*may be unfinished/)
    assert.equal(completion.truncated, null)
    assert.equal(completion.naturalEndingVerified, false)
  }
  for (const seconds of [undefined, NaN, 0, 34, 359]) {
    const completion = getMusicCompletion({ backend: 'yue2', lengthMode: 'automatic' }, seconds)
    assert.equal(completion.status, 'unknown')
    assert.equal(completion.warning, null)
    assert.equal(completion.naturalEndingVerified, false)
  }
  assert.match(getMusicCompletion({ backend: 'yue2', durationSeconds: 45 }, 45).warning, /45-second limit/)
  assert.equal(getMusicCompletion({ backend: 'ace-step', durationSeconds: 45 }, 45).status, 'not-applicable')
})

test('ACE-Step clamps and sanitizes existing music settings without changing its sampler', () => {
  const graph = buildAceStepWorkflow({ tags: '  rock  ', lyrics: 'Words', durationSeconds: 999, seed: -4.2, bpm: -1, keyScale: 'invalid', timeSignature: 'invalid', language: '' })
  assert.equal(graph['94'].inputs.tags, 'rock')
  assert.equal(graph['94'].inputs.lyrics, 'Words')
  assert.equal(graph['94'].inputs.duration, 240)
  assert.equal(graph['98'].inputs.seconds, 240)
  assert.equal(graph['94'].inputs.seed, 5)
  assert.equal(graph['3'].inputs.seed, 5)
  assert.equal(graph['94'].inputs.bpm, 40)
  assert.equal(graph['94'].inputs.keyscale, 'C major')
  assert.equal(graph['94'].inputs.timesignature, '4')
  assert.equal(graph['94'].inputs.language, 'en')
  assert.equal(graph['3'].inputs.steps, 8)
  assert.equal(graph['3'].inputs.sampler_name, 'euler')
  assert.equal(graph['3'].inputs.scheduler, 'simple')
})

test('YuE2 uses the native bundled checkpoint, full planning and one seed throughout', () => {
  const graph = buildYue2Workflow({ tags: '  bright indie pop  ', lyrics: '[verse]\nA new song', seed: 7821, durationSeconds: 22 })
  assert.equal(graph['104'].class_type, 'CheckpointLoaderSimple')
  assert.equal(graph['104'].inputs.ckpt_name, YUE2_MODEL)
  assert.equal(graph['94'].class_type, 'YuE2GenerateABC')
  assert.equal(graph['95'].class_type, 'YuE2GenerateMusic')
  assert.deepEqual(graph['94'].inputs.clip, ['104', 1])
  assert.deepEqual(graph['95'].inputs.clip, ['104', 1])
  assert.deepEqual(graph['95'].inputs.abc, ['94', 0])
  for (const id of ['94', '95']) {
    assert.equal(graph[id].inputs.style, 'bright indie pop')
    assert.equal(graph[id].inputs.lyrics, '[verse]\nA new song')
    assert.equal(graph[id].inputs.mode, 'full')
    assert.equal(graph[id].inputs.seed, 7821)
  }
  assert.equal(graph['3'].inputs.seed, 7821)
  assert.equal(graph['3'].inputs.steps, 32)
  assert.equal(graph['3'].inputs.sampler_name, 'dpm_2')
  assert.equal(graph['3'].inputs.scheduler, 'sgm_uniform')
  assert.deepEqual(graph['3'].inputs.model, ['104', 0])
  assert.deepEqual(graph['18'].inputs.vae, ['104', 2])
})

test('YuE2 maximum duration never becomes a fixed-duration latent', () => {
  for (const [requested, maximum] of [[30, 30], [1, 5], [1000, 360], [NaN, 30]]) {
    const graph = buildYue2Workflow({ durationSeconds: requested })
    assert.equal(graph['95'].inputs.max_duration, maximum)
    assert.equal(graph['98'].class_type, 'EmptyYuE2LatentAudio')
    assert.deepEqual(graph['98'].inputs.seconds, ['95', 1])
    assert.equal(Object.hasOwn(graph['95'].inputs, 'duration'), false)
  }
})

test('YuE2 instrumental mode clears lyrics and provides the same instruction to both planning stages', () => {
  const graph = buildYue2Workflow({ tags: 'piano, wistful, 90 bpm', lyrics: 'Must not be sung', instrumental: true })
  assert.equal(graph['94'].inputs.lyrics, '')
  assert.equal(graph['95'].inputs.lyrics, '')
  assert.match(graph['94'].inputs.style, /^Instrumental music only, no vocals or singing\./)
  assert.match(graph['94'].inputs.style, /piano, wistful, 90 bpm/)
  assert.equal(graph['94'].inputs.style, graph['95'].inputs.style)
  assert.equal(Object.hasOwn(graph['95'].inputs, 'instrumental'), false)
  assert.equal(Object.hasOwn(graph['95'].inputs, 'bpm'), false)
})

test('both graphs expose only the expected final audio saver, with managed output ownership prefixes', () => {
  for (const [backend, builder, type] of [['ace-step', buildAceStepWorkflow, 'SaveAudioMP3'], ['yue2', buildYue2Workflow, 'SaveAudioAdvanced']]) {
    const graph = builder()
    const outputId = getMusicBackend(backend).outputNodeId
    const outputNodes = Object.entries(graph).filter(([, node]) => node.class_type.startsWith('SaveAudio'))
    assert.equal(outputNodes.length, 1)
    assert.equal(outputNodes[0][0], outputId)
    assert.equal(graph[outputId].class_type, type)
    assert.match(graph[outputId].inputs.filename_prefix, /^audio\/velorn_music_/)
    assert.deepEqual(graph[outputId].inputs.audio, ['18', 0])
  }
  assert.equal(buildYue2Workflow()['107'].inputs.format, 'flac')
})

test('builders neither mutate caller options nor share mutable graph values between jobs', () => {
  const options = Object.freeze({ tags: 'gentle piano', lyrics: 'a lyric', instrumental: true, seed: 44, durationSeconds: 18 })
  for (const builder of [buildAceStepWorkflow, buildYue2Workflow]) {
    const graph = builder(options)
    const independent = builder(options)
    assert.deepEqual(graph, independent)
    graph['94'].inputs.seed = 200
    graph['107'].inputs.audio[0] = 'wrong'
    assert.equal(independent['94'].inputs.seed, 44)
    assert.deepEqual(independent['107'].inputs.audio, ['18', 0])
    assert.equal(options.seed, 44)
    assert.equal(options.lyrics, 'a lyric')
  }
})

test('workflow links target actual upstream nodes and existing return slots', () => {
  const outputCounts = {
    UNETLoader: 1, DualCLIPLoader: 1, VAELoader: 1, ModelSamplingAuraFlow: 1,
    TextEncodeAceStepAudio1_5: 1, ConditioningZeroOut: 1, EmptyAceStep1_5LatentAudio: 1,
    KSampler: 1, VAEDecodeAudio: 1, CheckpointLoaderSimple: 3, YuE2GenerateABC: 1,
    YuE2GenerateMusic: 2, EmptyYuE2LatentAudio: 1,
  }
  for (const builder of [buildAceStepWorkflow, buildYue2Workflow]) {
    const graph = builder()
    for (const node of Object.values(graph)) {
      for (const value of Object.values(node.inputs)) {
        if (!Array.isArray(value)) continue
        const [sourceId, slot] = value
        assert.ok(graph[sourceId], `missing upstream node ${sourceId}`)
        const sourceType = graph[sourceId].class_type.replaceAll('.', '_')
        assert.ok(slot >= 0 && slot < outputCounts[sourceType], `invalid slot ${sourceId}:${slot}`)
      }
    }
  }
})
