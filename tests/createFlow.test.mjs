import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { TEMPOS, cloudVoiceWorkflow, tempoBpm, withTempo, LOCAL_SOUND, stableAudioWorkflow, COMFY_CLOUD, SONILO_PROMPT_MAX, placeOf, soniloWorkflow, IDEAS, MOODS, SOUND_KINDS, lengthLabel, LOCAL_MUSIC, LOCAL_PRICE, localMusicProblem, localMusicRequest, NOUN, isAudioKind, rateText, capital, chargedText, creditsText, defaultModel, fitNote, fitOptions, footnote, goLabel, needText, priceText, problemFor, problemForJob, recordedPrice, sameDeal, unfinishedCreateJobs, PICK_UP_MAX, RESULT_KEPT_MS } from '../src/services/createFlow.mjs'

test('picks up only Create requests whose result can still be collected', () => {
  const now = 1_800_000_000_000, minute = 60_000
  const job = (jobId, extra = {}) => ({ jobId, create: true, status: 'IN_PROGRESS', kind: 'video', canRefresh: true, needsReconnect: false, createdAt: now - 10 * minute, ...extra })
  const listed = [
    job('running'),
    job('queued', { status: 'IN_QUEUE', createdAt: now - 30 * minute }),
    job('finished-unsaved', { status: 'COMPLETED', createdAt: now - 20 * minute }),
    job('finished-saved', { status: 'COMPLETED', importedAssetId: 'asset-1' }),
    job('failed', { status: 'FAILED' }),
    job('cancelled', { status: 'CANCELLED' }),
    job('unclear', { status: 'UNCERTAIN' }),
    job('never-accepted', { canRefresh: false }),
    job('other-key', { needsReconnect: true }),
    job('too-old', { createdAt: now - RESULT_KEPT_MS }),
    job('from-the-future', { createdAt: now + minute }),
    job('agent-picture', { create: undefined }),
  ]
  assert.deepEqual(unfinishedCreateJobs(listed, now).map(item => item.jobId), ['queued', 'finished-unsaved', 'running'])
  assert.deepEqual(unfinishedCreateJobs(null, now), [])
  assert.deepEqual(unfinishedCreateJobs([null, {}, job('ok')], now).map(item => item.jobId), ['ok'])
  const many = Array.from({ length: PICK_UP_MAX + 3 }, (_, i) => job(`j${i}`, { createdAt: now - (i + 1) * minute }))
  const kept = unfinishedCreateJobs(many, now)
  assert.equal(kept.length, PICK_UP_MAX)
  assert.equal(kept.at(-1).jobId, 'j0')
})

// The list exactly as the main process hands it to the screen.
const require = createRequire(import.meta.url)
const { listModels, sizesFor, resolutionsFor } = require('../electron/createModels.cjs')
const models = listModels().map(m => ({ id: m.id, kind: m.kind, name: m.name, note: m.note, default: m.default === true, refusalCharged: m.refusalCharged,
  firmQuote: m.quote === 'firm', editQuote: m.editQuote !== false,
  ...(m.kind === 'video' ? { seconds: m.seconds, resolutions: resolutionsFor(m), usdPerSecond: m.usdPerSecond } : { sizes: sizesFor(m), usdPerImage: m.usdPerImage }) }))
const by = id => models.find(m => m.id === id)

test('preselects the agreed defaults', () => {
  assert.equal(defaultModel(models, 'video').name, 'Seedance 2.5')
  assert.equal(defaultModel(models, 'image').name, 'Nano Banana 2.1')
  assert.equal(defaultModel([], 'image'), null)
})

test('pulls a choice back to what the model offers and says so', () => {
  assert.deepEqual(fitOptions(by('flux-3-image'), { size: '4K', shape: 'portrait' }), { shape: 'portrait', size: '4K' })
  assert.deepEqual(fitOptions(by('seedream-5-0-pro'), { size: '4K' }), { shape: 'landscape', size: '2K' })
  assert.equal(fitNote(by('seedream-5-0-pro'), { size: '4K' }), 'Seedream 5.0 Pro goes up to Large, so this uses Large.')
  assert.equal(fitNote(by('flux-3-image'), { size: '4K' }), '')
  assert.deepEqual(fitOptions(by('seedance-2-0-mini'), { seconds: 10, resolution: '1080p' }), { shape: 'landscape', seconds: 10, resolution: '720p' })
  assert.match(fitNote(by('seedance-2-0-mini'), { resolution: '1080p' }), /720p only/)
  assert.deepEqual(fitOptions(by('seedance-2-5'), { seconds: 7, shape: 'circle' }), { shape: 'landscape', seconds: 5, resolution: '720p' })
})

test('shows recorded prices the way the prototype words them', () => {
  assert.equal(priceText(recordedPrice(by('seedance-2-5'), {})), 'about $1.66')
  assert.equal(priceText(recordedPrice(by('seedance-2-5'), { seconds: 10 })), 'about $3.32')
  assert.equal(priceText(recordedPrice(by('nano-banana-2-1'), {})), 'usually about $0.06')
  assert.equal(priceText(recordedPrice(by('nano-banana-2-1'), { size: '4K' })), 'no firm price yet')
  assert.equal(priceText(recordedPrice(by('flux-3-image'), { size: '4K' })), 'about $0.87')
  assert.equal(priceText(recordedPrice(by('flux-3-image'), {}, { hasPicture: true })), 'usually about $0.07')
  assert.equal(priceText(recordedPrice(by('gpt-image-2-5'), {}, { hasPicture: true }), { editing: true }), 'no price before an edit')
  assert.equal(capital('about $1.66'), 'About $1.66')
})

test('a click approves the price it showed, not a noticeably higher one', () => {
  assert.equal(sameDeal({ usd: 1.66 }, { usd: 1.67 }), true)
  assert.equal(sameDeal({ usd: 0.02 }, { usd: 0.015 }), true)
  assert.equal(sameDeal({ usd: 0.07 }, { usd: 0.21 }), false)
  assert.equal(sameDeal({ usd: 0.07 }, null), false)
  assert.equal(sameDeal(null, { usd: 0.07 }), false)
  assert.equal(sameDeal(null, null), true)
})

test('prices can carry Comfy credits beside the dollars', () => {
  assert.equal(priceText(recordedPrice(by('nano-banana-2-1'), {}), { rate: 211 }), 'usually about $0.06 · 12 credits')
  assert.equal(priceText(recordedPrice(by('seedance-2-5'), { seconds: 10 }), { rate: 211 }), 'about $3.32 · 700 credits')
  assert.equal(priceText({ usd: 5.5, firm: true }, { rate: 211 }), 'about $5.50 · 1,161 credits')
  assert.equal(priceText(null, { rate: 211 }), 'no firm price yet')
  assert.equal(priceText({ usd: 0.06, firm: true }, { rate: 0 }), 'about $0.06')
  assert.deepEqual([creditsText(0.001, 211), creditsText(0.0047, 211), creditsText(1, 211), creditsText(1, null), creditsText(NaN, 211)], ['1 credit', '1 credit', '211 credits', '', ''])
  assert.equal(chargedText([{ chargedUsd: 0.0569, chargedCredits: 12 }]), 'charged 12 credits ($0.06)')
  assert.equal(chargedText([{ chargedUsd: 0.055, chargedCredits: 11.6 }, { chargedUsd: 0.055, chargedCredits: 11.6 }]), 'charged 23.2 credits ($0.11)')
  assert.equal(chargedText([{ chargedUsd: 0.0047, chargedCredits: 1 }]), 'charged 1 credit ($0.00)')
  assert.equal(chargedText([{ chargedUsd: 0.06 }]), 'charged $0.06')
  assert.equal(chargedText([{ chargedUsd: 0.06, chargedCredits: 12 }, {}]), '')
  assert.equal(chargedText([]), '')
  assert.equal(needText({ usd: 0.055, firm: false }, 211), "This needs about 12 Comfy credits ($0.06), and your account doesn't have enough.")
  assert.equal(needText({ usd: 0.004, firm: true }, 211), "This needs about 1 Comfy credit ($0.00), and your account doesn't have enough.")
  assert.equal(needText({ usd: 0.055, firm: true }, null), "This needs about $0.06 in Comfy credits, and your account doesn't have enough.")
  assert.equal(needText(null, 211), "Your Comfy account doesn't have enough credits for this.")
})

test('voice, sound and music fit their own choices and prices', () => {
  const audio = listModels().filter(m => ['voice', 'sound'].includes(m.kind)).map(m => ({ id: m.id, kind: m.kind, name: m.name, firmQuote: m.quote === 'firm',
    ...(m.kind === 'voice' ? { characters: m.characters, usdPer1kCharacters: m.usdPer1kCharacters } : { seconds: m.seconds, usdPerAudioSecond: m.usdPerAudioSecond }) }))
  const voice = audio.find(m => m.id === 'eleven-v4'), sound = audio.find(m => m.id === 'eleven-sfx-v2'), music = LOCAL_MUSIC[0]
  const voices = [{ id: 'rachel', name: 'Rachel' }, { id: 'george', name: 'George' }]
  assert.deepEqual(fitOptions(voice, {}, { voices }), { voice: 'rachel' })
  assert.deepEqual(fitOptions(voice, { voice: 'george', shape: 'square' }, { voices }), { voice: 'george' })
  assert.deepEqual(fitOptions(voice, { voice: 'nobody' }, { voices }), { voice: 'rachel' })
  assert.deepEqual(fitOptions(voice, {}, {}), { voice: '' })
  assert.deepEqual(fitOptions(sound, {}), { seconds: 3 })
  assert.deepEqual(fitOptions(sound, { seconds: 10 }), { seconds: 10 })
  assert.deepEqual(fitOptions(sound, { seconds: 7 }), { seconds: 3 })
  assert.deepEqual(fitOptions(music, { seconds: 120 }), { seconds: 120 })
  assert.equal(recordedPrice(voice, {}, { characters: 0 }), null)
  assert.equal(recordedPrice(voice, {}, { characters: 3001 }), null)
  assert.equal(priceText(recordedPrice(voice, {}, { characters: 1000 }), { rate: 211 }), 'about $0.11 · 24 credits')
  assert.equal(priceText(recordedPrice(voice, {}, { characters: 20 }), { rate: 211 }), 'under $0.01 · 1 credit')
  assert.equal(priceText(recordedPrice(sound, { seconds: 20 }), { rate: 211 }), 'about $0.05 · 10 credits')
  // Music made on this computer has no price at all.
  assert.equal(recordedPrice(music, { seconds: 180 }), null)
  assert.equal(LOCAL_PRICE, 'free, made on this computer')
  assert.deepEqual(LOCAL_MUSIC.map(m => [m.id, m.backend, m.default === true]), [['local-yue2', 'yue2', true], ['local-ace-step', 'ace-step', false]])
  assert.equal(defaultModel([...audio, ...LOCAL_MUSIC], 'music').name, 'YuE2')
  assert.deepEqual(localMusicRequest(LOCAL_MUSIC[0], '  warm lo-fi  ', { seconds: 60 }), { backend: 'yue2', tags: 'warm lo-fi', instrumental: true, durationSeconds: 60, variations: 1, lengthMode: 'custom' })
  assert.deepEqual(localMusicRequest(LOCAL_MUSIC[1], 'warm lo-fi', { seconds: 30 }), { backend: 'ace-step', tags: 'warm lo-fi', instrumental: true, durationSeconds: 30, variations: 1 })
  assert.match(localMusicProblem(new Error('YuE2 is not ready. Check its models and update ComfyUI if nodes are missing.')), /not ready\..* Music button on the timeline\.$/)
  assert.equal(localMusicProblem(new Error('The project changed. Generate again from the intended project.')), 'The project changed. Generate again from the intended project.')
  assert.match(localMusicProblem(null), /^The music could not be started/)
  assert.deepEqual(localMusicRequest(LOCAL_MUSIC[0], 'warm lo-fi', { seconds: 60 }, '  la la la  '), { backend: 'yue2', tags: 'warm lo-fi', instrumental: false, lyrics: 'la la la', durationSeconds: 60, variations: 1, lengthMode: 'custom' })
  assert.equal(localMusicRequest(LOCAL_MUSIC[1], 'x', { seconds: 30 }, '   ').instrumental, true)
  // The Sound tab's own pieces.
  assert.deepEqual(SOUND_KINDS, ['voice', 'music', 'sound'])
  assert.deepEqual([30, 60, 120, 3].map(lengthLabel), ['30 sec', '1 min', '2 min', '3 sec'])
  assert.ok(MOODS.length >= 4 && MOODS.every(mood => mood.name && mood.prompt.length > 20))
  assert.ok(IDEAS.length === 4 && IDEAS.every(text => text.length > 5))
  assert.match(footnote({ connected: false, model: music }), /^Made on this computer/)
  assert.equal(rateText(voice, 211), '$0.11 · 24 credits per 1,000 characters')
  assert.equal(rateText(sound, 211), '')
  assert.deepEqual(['image', 'video', 'voice', 'sound', 'music', 'other'].map(NOUN), ['image', 'video', 'voice recording', 'sound effect', 'music', 'image'])
  assert.deepEqual(['voice', 'sound', 'music'].map(kind => goLabel({ step: 'compose', kind })), ['Generate voice', 'Generate effect', 'Generate music'])
  assert.deepEqual(['image', 'video', 'voice'].map(isAudioKind), [false, false, true])
  assert.match(problemFor({ code: 'COMFY_ROUTER_UNCERTAIN' }, { kind: 'sound' }).body, /^Your sound effect may still/)
  assert.match(problemFor({ code: 'COMFY_ROUTER_UNCERTAIN' }, { kind: 'voice' }).body, /^Your voice recording may still be on its way/)
  assert.equal(problemForJob({ status: 'UNCERTAIN' }, { kind: 'sound' }).kind, 'lost')
})

test('cloud songs run as a Sonilo node inside ComfyUI', () => {
  const sonilo = COMFY_CLOUD.find(m => m.id === 'sonilo')
  assert.deepEqual([sonilo.id, sonilo.kind, sonilo.via, placeOf(sonilo), placeOf(LOCAL_MUSIC[0]), placeOf(by('flux-3-image'))], ['sonilo', 'music', 'comfyui', 'cloud', 'local', 'cloud'])
  // A description alone is the instrumental node, priced at 0.5275 credits a second.
  assert.deepEqual(soniloWorkflow({ prompt: '  warm lo-fi  ', seconds: 60, seed: 7 }), {
    1: { class_type: 'SoniloTextToMusic', inputs: { prompt: 'warm lo-fi', duration: 60, seed: 7 } },
    2: { class_type: 'SaveAudioMP3', inputs: { audio: ['1', 0], filename_prefix: 'audio/velorn_sonilo', quality: 'V0' } } })
  assert.equal(priceText(recordedPrice(sonilo, { seconds: 60 }), { rate: 211 }), 'about $0.15 · 32 credits')
  // Lyrics switch to the sung model, with the words in a Lyrics block and a custom length.
  const sung = soniloWorkflow({ prompt: 'folk-pop at 96 BPM', seconds: 120, lyrics: ' [Verse]\nHello ', seed: 9 })
  assert.deepEqual(sung[1], { class_type: 'SoniloMusic15', inputs: { prompt: 'folk-pop at 96 BPM\n\nLyrics:\n[Verse]\nHello', duration: 'custom', 'duration.seconds': 120, seed: 9 } })
  assert.equal(priceText(recordedPrice({ ...sonilo, usdPerAudioSecond: sonilo.usdPerAudioSecondSung }, { seconds: 120 }), {}), 'about $0.39')
  assert.throws(() => soniloWorkflow({ prompt: ' ', seconds: 60, seed: 1 }), /description/)
  assert.throws(() => soniloWorkflow({ prompt: 'x', seconds: 5, seed: 1 }), /10 seconds to 6 minutes/)
  assert.throws(() => soniloWorkflow({ prompt: 'x', seconds: 60, seed: -1 }), /seed/)
  assert.throws(() => soniloWorkflow({ prompt: 'x'.repeat(1500), lyrics: 'y'.repeat(600), seconds: 60, seed: 1 }), /2,000 characters/)
  assert.equal(SONILO_PROMPT_MAX, 2000)
  assert.match(footnote({ connected: false, model: sonilo }), /^Runs through ComfyUI/)
})

test('local effects run Stable Audio 3.0 as a plain ComfyUI workflow', () => {
  const model = LOCAL_SOUND[0]
  assert.deepEqual([model.id, model.kind, model.local, model.workflowId, placeOf(model)], ['local-stable-audio-3', 'sound', true, 'sound-stable-audio-3', 'local'])
  assert.equal(recordedPrice(model, { seconds: 5 }), null)
  assert.deepEqual(fitOptions(model, { seconds: 10 }), { seconds: 10 })
  const flow = stableAudioWorkflow({ prompt: '  rain on a window ', seconds: 5, seed: 3 })
  assert.deepEqual(Object.values(flow).map(node => node.class_type), ['CheckpointLoaderSimple', 'CLIPLoader', 'CLIPTextEncode', 'CLIPTextEncode', 'EmptyLatentAudio', 'KSampler', 'VAEDecodeAudio', 'SaveAudioMP3'])
  assert.equal(flow[3].inputs.text, 'rain on a window')
  assert.deepEqual(flow[5].inputs, { seconds: 5, batch_size: 1 })
  assert.deepEqual([flow[6].inputs.seed, flow[6].inputs.steps, flow[6].inputs.sampler_name], [3, 8, 'lcm'])
  assert.deepEqual(flow[8].inputs.audio, ['7', 0])
  assert.throws(() => stableAudioWorkflow({ prompt: '', seconds: 5, seed: 1 }), /description/)
  assert.throws(() => stableAudioWorkflow({ prompt: 'x', seconds: 0, seed: 1 }), /1 second/)
  // Every local model names the workflow whose files the setup panel checks for.
  assert.deepEqual([...LOCAL_MUSIC, ...LOCAL_SOUND].map(m => m.workflowId), ['music-gen-yue2', 'music-gen', 'sound-stable-audio-3'])
})

test('cloud voices from Fish Audio and HeyGen run as nodes inside ComfyUI', () => {
  const byId = id => COMFY_CLOUD.find(m => m.id === id)
  const fish = byId('fish-s2-pro'), drama = byId('fish-drama-3'), heygen = byId('heygen-tts')
  assert.deepEqual([fish, drama, heygen].map(m => [m.kind, m.via, placeOf(m), m.voices.length]), [['voice', 'comfyui', 'cloud', 13], ['voice', 'comfyui', 'cloud', 13], ['voice', 'comfyui', 'cloud', 15]])
  // Each model picks from its own voices.
  assert.deepEqual(fitOptions(fish, { voice: 'rachel' }, { voices: fish.voices }), { voice: 'Energetic Male (en)' })
  assert.deepEqual(fitOptions(heygen, { voice: 'Aria (English, female)' }, { voices: heygen.voices }), { voice: 'Aria (English, female)' })
  const spoken = cloudVoiceWorkflow(fish, { text: '  Hello there.  ', voice: 'Delia (en)', seed: 5 })
  assert.equal(spoken.outputNodeId, '3')
  assert.deepEqual(spoken.workflow[1], { class_type: 'FishAudioVoiceSelector', inputs: { voice: 'Delia (en)' } })
  assert.deepEqual(spoken.workflow[2].inputs, { text: 'Hello there.', model: 's2.1-pro', 'model.voices.voice0': ['1', 0], 'model.temperature': 0.7, 'model.top_p': 0.7, 'model.speed': 1, 'model.volume': 0, 'model.normalize': true, seed: 5 })
  assert.equal(cloudVoiceWorkflow(drama, { text: '[calm] Hi.', voice: 'Delia (en)', seed: 5 }).workflow[2].inputs.model, 'drama-3')
  const presenter = cloudVoiceWorkflow(heygen, { text: 'Hello.', voice: 'Chill Brian (English, male)', seed: 9 })
  assert.deepEqual(presenter, { outputNodeId: '2', workflow: {
    1: { class_type: 'HeyGenTextToSpeechNode', inputs: { text: 'Hello.', voice: 'Chill Brian (English, male)', custom_voice_id: '', speed: 1, ssml: false, seed: 9 } },
    2: { class_type: 'SaveAudioMP3', inputs: { audio: ['1', 0], filename_prefix: 'audio/velorn_heygen', quality: 'V0' } } } })
  assert.throws(() => cloudVoiceWorkflow(fish, { text: ' ', voice: 'Delia (en)', seed: 1 }), /what the voice should say/)
  assert.throws(() => cloudVoiceWorkflow(fish, { text: 'Hi', voice: 'Chill Brian (English, male)', seed: 1 }), /Choose a voice/)
  assert.throws(() => cloudVoiceWorkflow(fish, { text: 'x'.repeat(3001), voice: 'Delia (en)', seed: 1 }), /3,000 characters/)
  assert.throws(() => cloudVoiceWorkflow(heygen, { text: 'Hi', voice: 'Aria (English, female)', seed: 2 ** 31 }), /seed/)
  // Prices: Fish by the amount of text, HeyGen an estimate because it charges by recording length.
  assert.equal(priceText(recordedPrice(fish, {}, { characters: 1000 }), { rate: 211 }), 'about $0.02 · 5 credits')
  assert.equal(priceText(recordedPrice(drama, {}, { characters: 1000 }), {}), 'about $0.04')
  assert.equal(priceText(recordedPrice(heygen, {}, { characters: 1000 }), {}), 'usually about $0.06')
})

test('tempo is a real number for ACE-Step and words in the description for the others', () => {
  assert.deepEqual(TEMPOS.map(t => [t.id, t.bpm]), [['auto', null], ['slow', 75], ['medium', 105], ['fast', 140]])
  assert.deepEqual([tempoBpm('fast'), tempoBpm('auto'), tempoBpm(undefined), tempoBpm('nope')], [140, null, null, null])
  assert.deepEqual([withTempo(' warm lo-fi ', 75), withTempo('warm lo-fi', null)], ['warm lo-fi, 75 BPM', 'warm lo-fi'])
  assert.deepEqual(localMusicRequest(LOCAL_MUSIC[1], 'warm lo-fi', { seconds: 30 }, '', 140), { backend: 'ace-step', tags: 'warm lo-fi', instrumental: true, durationSeconds: 30, variations: 1, bpm: 140 })
  assert.equal(localMusicRequest(LOCAL_MUSIC[0], 'warm lo-fi', { seconds: 30 }, '', 140).tags, 'warm lo-fi, 140 bpm')
  assert.equal(localMusicRequest(LOCAL_MUSIC[0], 'warm lo-fi', { seconds: 30 }, '', null).tags, 'warm lo-fi')
  assert.equal('bpm' in localMusicRequest(LOCAL_MUSIC[0], 'x', { seconds: 30 }, '', 140), false)
})

test('the line under the box warns up front', () => {
  assert.equal(footnote({ connected: false }), 'You see the cost before anything is charged.')
  assert.equal(footnote({ connected: true, remembered: true, model: by('nano-banana-2-1'), price: { usd: 0.055 } }),
    'Uses credits from your Comfy account. You see the exact cost after each picture. This model charges even if it refuses a request.')
  assert.equal(footnote({ connected: true, remembered: false, model: by('flux-3-image'), price: { usd: 0.07 } }), 'Uses credits from your Comfy account. Your key is kept until Velorn closes.')
})

test('each Comfy answer leads to the right screen', () => {
  const context = { model: by('nano-banana-2-1'), kind: 'image' }
  assert.match(problemFor({ code: 'COMFY_ROUTER_AUTH' }).keyError, /didn't accept that key/)
  assert.match(problemFor({ code: 'COMFY_ROUTER_ACCESS', queueNotEnabled: true, diagnostics: { httpStatus: 403, errorType: 'not_enabled' } }).keyError, /older kind of Comfy key/)
  // The same answer while making something with a connected key is about that one model, and nobody is sent to make a new key.
  const refusedModel = problemFor({ code: 'COMFY_ROUTER_ACCESS', queueNotEnabled: true, diagnostics: { httpStatus: 403, errorType: 'not_enabled' } }, { model: { name: 'Pika Music' }, kind: 'music' })
  assert.deepEqual([refusedModel.screen, refusedModel.keyError], ['compose', undefined])
  assert.match(refusedModel.notice, /Comfy has not switched on Pika Music for your account yet\. Choose another model\./)
  const refusedJob = problemForJob({ status: 'FAILED', errorType: 'REQUEST_REJECTED', diagnostics: { httpStatus: 403, errorType: 'not_enabled' } }, { model: { name: 'Pika Music' }, kind: 'music' })
  assert.equal(refusedJob.screen, 'compose')
  assert.deepEqual(problemFor({ code: 'COMFY_ROUTER_KEY_REQUIRED' }), { screen: 'connect', keyError: '' })
  assert.equal(problemFor({ code: 'COMFY_ROUTER_ACCESS', diagnostics: { httpStatus: 402, errorType: 'insufficient_credits' } }).screen, 'nocredits')
  assert.deepEqual(problemFor({ code: 'COMFY_ROUTER_DECLINED' }), { screen: 'compose' })
  assert.match(problemFor({ code: 'COMFY_ROUTER_LOCAL_ONLY' }).notice, /Ask before cloud/)
  assert.match(problemFor({ code: 'COMFY_ROUTER_PROJECT_REQUIRED' }).notice, /project first/)
  assert.equal(problemFor({ code: 'COMFY_ROUTER_INVALID', error: 'Seedance 2.0 Mini does not offer 1080p.' }).notice, 'Seedance 2.0 Mini does not offer 1080p.')
  const blocked = problemFor({ code: 'COMFY_ROUTER_PROVIDER', diagnostics: { httpStatus: 400, errorType: 'content_policy_violation' } }, context)
  assert.deepEqual([blocked.kind, blocked.note], ['blocked', 'Nano Banana 2.1 charges for a request even when it refuses it.'])
  assert.equal(problemFor({ diagnostics: { httpStatus: 400, errorType: 'content_policy_violation' } }, { model: by('flux-3-image') }).note, "You weren't charged for this.")
  assert.match(problemFor({ diagnostics: { httpStatus: 400, errorType: 'content_policy_violation' } }, { model: by('gpt-image-2-5') }).note, /usage page/)
  const lost = problemFor({ code: 'COMFY_ROUTER_UNCERTAIN' }, { kind: 'video' })
  assert.deepEqual([lost.kind, /video may still be on its way/.test(lost.body), /pay twice/.test(lost.body)], ['lost', true, true])
  assert.deepEqual([problemFor({ code: 'COMFY_ROUTER_PROVIDER', diagnostics: { httpStatus: 500 } }).kind, problemFor({}).primary], ['failed', 'Try again'])
})

test('a finished job that did not succeed is explained', () => {
  assert.match(problemForJob({ status: 'CANCELLED' }).notice, /Stopped/)
  assert.equal(problemForJob({ status: 'FAILED', errorType: 'content_policy_violation' }, { model: by('seedream-4-0') }).kind, 'blocked')
  assert.equal(problemForJob({ status: 'FAILED', errorType: 'insufficient_credits' }).screen, 'nocredits')
  assert.equal(problemForJob({ status: 'FAILED', errorType: 'provider_error' }).kind, 'failed')
})

test('the button says what it will do', () => {
  assert.equal(goLabel({ step: 'compose', kind: 'image', editing: false }), 'Generate image')
  assert.equal(goLabel({ step: 'compose', kind: 'image', editing: true }), 'Edit image')
  assert.equal(goLabel({ step: 'compose', kind: 'video' }), 'Generate video')
  assert.equal(goLabel({ step: 'generating', kind: 'video' }), 'Generating…')
})

test('offers only project pictures Create can send, newest first', async () => {
  const { pictureTypeFor, usablePictures } = await import('../src/services/createFlow.mjs')
  const assets = [
    { id: 'a', type: 'image', url: 'u1', name: 'old.png' },
    { id: 'b', type: 'video', url: 'u2', name: 'clip.mp4' },
    { id: 'c', type: 'image', url: 'u3', name: 'photo.JPG' },
    { id: 'd', type: 'image', url: 'u4', name: 'drawing.svg' },
    { id: 'e', type: 'image', url: '', name: 'missing.png' },
    { id: 'f', type: 'image', url: 'u6', name: 'x', absolutePath: '/p/assets/images/new.webp' },
  ]
  assert.deepEqual(usablePictures(assets).map(a => a.id), ['f', 'c', 'a'])
  assert.deepEqual(['a.png', 'b.jpeg', 'c.WebP', 'd.gif', 'noext'].map(name => pictureTypeFor({ name })), ['image/png', 'image/jpeg', 'image/webp', '', ''])
  assert.deepEqual(usablePictures(null), [])
})
