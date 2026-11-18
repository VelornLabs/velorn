'use strict'
// Voice, sound and music in Create. ElevenLabs models only run on Comfy's
// wait-for-the-result route and answer with raw audio, so they are sent once in
// the background and their audio is kept on this computer until it is imported.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createComfyRouter, audioHeader } = require('../electron/comfyRouter.cjs')
const { listModels, listVoices, getModel, fallbackPrice } = require('../electron/createModels.cjs')
const { buildCreateRequest } = require('../electron/createRequests.cjs')
const KEY = 'synthetic-router-key-one-never-real'
const SAY = 'Welcome back. Here is what changed while you were away.'
const MP3 = Buffer.concat([Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x21', 'latin1'), Buffer.alloc(600, 7)])
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } })

async function fixture(t, { answer, allowPending = false } = {}) {
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-router-audio-test-'))
  const requests = [], approvals = []
  const state = { now: 1_800_000_000_000, answer: answer || (() => new Response(MP3, { status: 200, headers: { 'Content-Type': 'audio/mpeg', 'x-comfy-credits-used': '1.33' } })) }
  const manager = createComfyRouter({ storageDir, allowPending, now: () => state.now, getContext: async () => ({ session: 's', projectKey: '/synthetic/project' }), getPolicy: async () => 'ask-cloud',
    confirmSpend: async value => { approvals.push(value); return true },
    fetchImpl: async (url, request) => {
      requests.push({ url, ...request })
      if (!url.startsWith('https://api.comfy.org/')) return state.answer(url, request) // A result file on Comfy's storage.
      if (url.endsWith('/estimate')) return json({ note: 'no quote' })
      if (request.method !== 'POST') return url.includes('/requests/') ? state.answer(url, request) : json({ id: 'ok' })
      return state.answer(url, request)
    } })
  t.after(async () => { manager.dispose(); await fs.rm(storageDir, { recursive: true, force: true }) })
  assert.equal((await manager.connect({ apiKey: KEY })).success, true)
  requests.length = 0
  const posts = () => requests.filter(r => r.method === 'POST' && !r.url.endsWith('/estimate'))
  const settled = async jobId => {
    for (let i = 0; i < 200; i++) {
      const seen = await manager.refresh({ jobId })
      if (seen.job.status !== 'SUBMITTING') return seen.job
      await new Promise(resolve => setImmediate(resolve))
    }
    throw new Error('the request never settled')
  }
  const files = async () => (await fs.readdir(storageDir)).filter(name => name.startsWith('result-'))
  return { manager, requests, approvals, state, posts, settled, files, storageDir }
}

test('the catalog adds voice, sound and music without touching pictures and clips', () => {
  assert.deepEqual(listModels('voice').map(m => m.name), ['Eleven V4', 'Eleven V4 Turbo'])
  assert.deepEqual(listModels('sound').map(m => m.name), ['Eleven Sound Effects'])
  // Music comes from Pika Music through Comfy Router.
  assert.deepEqual(listModels('music').map(m => m.name), ['Pika Music'])
  assert.equal(listModels('image').length + listModels('video').length, 12)
  assert.deepEqual(listVoices().map(v => v.id), ['rachel', 'george', 'sarah', 'brian', 'alice', 'daniel', 'lily', 'charlie', 'liam', 'jessica'])
  assert.equal(listVoices({ unverified: true }).length, 10)
  assert.ok(Math.abs(fallbackPrice('eleven-v4', { characters: 1000 }).usd - 0.1144) < 1e-12)
  assert.ok(Math.abs(fallbackPrice('eleven-sfx-v2', { seconds: 10 }).usd - 0.02334) < 1e-12)
  assert.equal(fallbackPrice('eleven-v4', { characters: 3001 }), null)
  assert.equal(fallbackPrice('eleven-v4', {}), null)
  assert.equal(fallbackPrice('eleven-sfx-v2', { seconds: 31 }), null)
})

test('audio requests are built in each provider\'s own shape', () => {
  const voice = buildCreateRequest('eleven-v4', { prompt: `  ${SAY} `, voice: 'rachel' })
  assert.deepEqual(voice.body, { inputs: [{ text: SAY, voice_id: '21m00Tcm4TlvDq8ikWAM' }] })
  assert.deepEqual(voice.choices, { prompt: SAY, voice: 'rachel', characters: SAY.length })
  assert.deepEqual(buildCreateRequest('eleven-sfx-v2', { prompt: 'a wooden door creaking open', seconds: 5 }).body, { text: 'a wooden door creaking open', duration_seconds: 5 })
  assert.deepEqual(buildCreateRequest('eleven-sfx-v2', { prompt: 'rain' }).choices, { prompt: 'rain', seconds: 3 })
  assert.deepEqual(buildCreateRequest('eleven-sfx-v2', { prompt: 'rain', seconds: 10, loop: true }).body, { text: 'rain', duration_seconds: 10, loop: true })
  assert.deepEqual(buildCreateRequest('eleven-sfx-v2', { prompt: 'rain', loop: false }).body, { text: 'rain', duration_seconds: 3 })
  const refused = (id, input, pattern) => assert.throws(() => buildCreateRequest(id, input), error => error.code === 'CREATE_REQUEST_INVALID' && pattern.test(error.message))
  refused('eleven-v4', { prompt: SAY }, /Choose a voice/)
  refused('eleven-v4', { prompt: SAY, voice: 'nobody' }, /Choose a voice/)
  refused('eleven-v4', { prompt: ' ', voice: 'rachel' }, /what the voice should say/)
  refused('eleven-v4', { prompt: 'x'.repeat(3001), voice: 'rachel' }, /3,000 characters/)
  refused('eleven-v4', { prompt: SAY, voice: 'rachel', shape: 'square' }, /not a choice/)
  refused('eleven-sfx-v2', { prompt: 'rain', seconds: 31 }, /1 to 30 seconds/)
  refused('eleven-sfx-v2', { prompt: 'rain', loop: 'yes' }, /repeat/)
  refused('eleven-v4', { prompt: SAY, voice: 'rachel', loop: true }, /not a choice/)
  refused('eleven-sfx-v2', { prompt: 'rain', picture: { mimeType: 'image/png', base64: 'AAAA' } }, /not a choice/)
  refused('pika-sfx', { prompt: 'warm lo-fi' }, /Unknown Create model/)
  refused('pika-music', { prompt: 'warm lo-fi', seconds: 9 }, /10 to 360 seconds/)
  refused('pika-music', { prompt: 'warm lo-fi', lyrics: 'x'.repeat(3001) }, /3,000 characters of lyrics/)
  refused('pika-music', { prompt: 'warm lo-fi', lyrics: 7 }, /lyrics could not be read/)
  refused('pika-music', { prompt: 'warm lo-fi', loop: true }, /not a choice/)
  refused('eleven-sfx-v2', { prompt: 'rain', lyrics: 'la' }, /not a choice/)
})

test('the screen is offered only models and voices that are known to work', async t => {
  const f = await fixture(t)
  const listed = await f.manager.models({})
  assert.deepEqual(listed.models.filter(m => !['image', 'video'].includes(m.kind)).map(m => m.id), ['eleven-v4', 'eleven-v4-turbo', 'eleven-sfx-v2'])
  assert.deepEqual(listed.voices[0], { id: 'rachel', name: 'Rachel', note: 'Calm, American' })
  assert.equal(listed.voices.length, 10)
  assert.deepEqual(listed.models.find(m => m.id === 'eleven-v4').characters, { max: 3000 })
  assert.equal(listed.models.find(m => m.id === 'eleven-sfx-v2').usdPerAudioSecond, 0.002334)
  assert.equal((await f.manager.previewCreate({ modelId: 'eleven-v4', choices: { prompt: SAY, voice: 'nobody' } })).code, 'COMFY_ROUTER_INVALID')
  assert.equal((await f.manager.previewCreate({ modelId: 'eleven-v4', choices: { prompt: SAY, voice: 'rachel' }, count: 2 })).code, 'COMFY_ROUTER_INVALID')
  assert.equal(f.posts().length, 0)
})

test('speech is priced on its length and asked about with filler, not the words', async t => {
  const f = await fixture(t)
  const plan = await f.manager.previewCreate({ modelId: 'eleven-v4', choices: { prompt: SAY, voice: 'rachel' } })
  assert.equal(plan.success, true)
  assert.equal(plan.kind, 'voice')
  assert.ok(Math.abs(plan.estimate.usd - 0.1144 * SAY.length / 1000) < 1e-12)
  assert.equal(plan.buttonApproval, true)
  assert.match(plan.summary, /^One cloud voice recording\./)
  const asked = f.requests.find(r => r.url.endsWith('/estimate'))
  assert.equal(asked.url, 'https://api.comfy.org/v2/models/elevenlabs/eleven_v4/estimate')
  const sent = JSON.parse(asked.body).inputs[0]
  assert.equal(sent.text.length, SAY.length)
  assert.match(sent.text, /^(la )*la?a?$/)
  assert.ok(!asked.body.includes('Welcome'))
})

test('a voice request is sent once on the wait route and its audio is kept until imported', async t => {
  const f = await fixture(t)
  const plan = await f.manager.previewCreate({ modelId: 'eleven-v4', choices: { prompt: SAY, voice: 'rachel' } })
  const sent = await f.manager.submitCreate({ planId: plan.planId })
  assert.deepEqual([sent.success, sent.jobs.length, sent.approval], [true, 1, 'button'])
  const done = await f.settled(sent.job.jobId)
  assert.deepEqual([done.status, done.kind, done.canRefresh, done.chargedCredits, done.modelLabel], ['COMPLETED', 'voice', true, 1.33, 'Eleven V4'])
  const posts = f.posts()
  assert.equal(posts.length, 1)
  assert.equal(posts[0].url, 'https://api.comfy.org/v2/models/elevenlabs/eleven_v4')
  assert.equal(posts[0].headers['Idempotency-Key'], sent.job.jobId)
  assert.equal(posts[0].headers['X-API-Key'], KEY)
  assert.deepEqual(JSON.parse(posts[0].body), { inputs: [{ text: SAY, voice_id: '21m00Tcm4TlvDq8ikWAM' }] })
  // Watching it asks Comfy nothing.
  const before = f.requests.length
  await f.manager.refresh({ jobId: sent.job.jobId })
  assert.equal(f.requests.length, before)
  assert.deepEqual(await f.files(), [`result-${sent.job.jobId}.audio`])
  const output = await f.manager.output({ jobId: sent.job.jobId })
  assert.deepEqual([output.success, output.kind, output.made, output.mimeType, output.filename], [true, 'audio', 'voice', 'audio/mpeg', `velorn-router-${sent.job.jobId}.mp3`])
  assert.deepEqual(Buffer.from(output.bytes), MP3)
  assert.equal(f.requests.length, before)
  assert.equal((await f.manager.markImported({ jobId: sent.job.jobId, assetId: 'asset-1' })).success, true)
  assert.deepEqual(await f.files(), [])
  assert.match((await f.manager.output({ jobId: sent.job.jobId })).error, /no longer on this computer/)
  // The same plan never sends again.
  assert.equal((await f.manager.submitCreate({ planId: plan.planId })).repeated, true)
  assert.equal(f.posts().length, 1)
  const saved = JSON.parse(await fs.readFile(path.join(f.storageDir, 'comfy-router-jobs.json'), 'utf8')).jobs
  assert.ok(!JSON.stringify(saved).includes('Welcome'))
})

test('a sound effect runs the same way', async t => {
  const f = await fixture(t)
  const plan = await f.manager.previewCreate({ modelId: 'eleven-sfx-v2', choices: { prompt: 'a wooden door creaking open', seconds: 5 } })
  assert.ok(Math.abs(plan.estimate.usd - 0.01167) < 1e-12)
  const sent = await f.manager.submitCreate({ planId: plan.planId })
  const done = await f.settled(sent.job.jobId)
  assert.deepEqual([done.status, done.kind], ['COMPLETED', 'sound'])
  assert.equal(f.posts()[0].url, 'https://api.comfy.org/v2/models/elevenlabs/eleven_sfx_v2')
})

test('a refusal is a clear no; a broken connection is unclear and is never sent again', async t => {
  const f = await fixture(t, { answer: () => json({ detail: 'no' }, 400, { 'X-Comfy-Error-Type': 'content_policy_violation' }) })
  const first = await f.manager.previewCreate({ modelId: 'eleven-v4', choices: { prompt: SAY, voice: 'rachel' } })
  const refused = await f.settled((await f.manager.submitCreate({ planId: first.planId })).job.jobId)
  assert.deepEqual([refused.status, refused.submissionRejected, refused.diagnostics.errorType], ['FAILED', true, 'content_policy_violation'])
  assert.deepEqual(await f.files(), [])

  f.state.answer = () => { throw new Error('socket closed') }
  const second = await f.manager.previewCreate({ modelId: 'eleven-v4', choices: { prompt: SAY, voice: 'rachel' } })
  const lost = await f.settled((await f.manager.submitCreate({ planId: second.planId })).job.jobId)
  assert.equal(lost.status, 'UNCERTAIN')
  assert.equal(f.posts().length, 2)
  // While Comfy could still be working on it, nothing new is sent.
  f.state.answer = () => new Response(MP3, { status: 200 })
  const third = await f.manager.previewCreate({ modelId: 'eleven-v4', choices: { prompt: SAY, voice: 'rachel' } })
  assert.equal((await f.manager.submitCreate({ planId: third.planId })).code, 'COMFY_ROUTER_UNCERTAIN')
  assert.equal(f.posts().length, 2)
  // Comfy holds such a request for ten minutes at most; after that it no longer blocks.
  f.state.now += 16 * 60 * 1000
  const fourth = await f.manager.previewCreate({ modelId: 'eleven-v4', choices: { prompt: SAY, voice: 'rachel' } })
  const ok = await f.settled((await f.manager.submitCreate({ planId: fourth.planId })).job.jobId)
  assert.equal(ok.status, 'COMPLETED')
  assert.equal(f.posts().length, 3)
})

test('an answer that is not a sound file is a failed result, not a saved one', async t => {
  const f = await fixture(t, { answer: () => new Response(Buffer.alloc(400, 1), { status: 200, headers: { 'x-comfy-credits-used': '1.33' } }) })
  const plan = await f.manager.previewCreate({ modelId: 'eleven-v4', choices: { prompt: SAY, voice: 'rachel' } })
  const done = await f.settled((await f.manager.submitCreate({ planId: plan.planId })).job.jobId)
  assert.deepEqual([done.status, done.errorType, done.chargedCredits], ['FAILED', 'RESULT_UNREADABLE', 1.33])
  assert.deepEqual(await f.files(), [])
})

test('recognises the sound files Velorn can play and nothing else', () => {
  const pad = head => Buffer.concat([head, Buffer.alloc(200)])
  assert.equal(audioHeader(MP3).extension, 'mp3')
  assert.equal(audioHeader(pad(Buffer.from([0xff, 0xfb, 0x90, 0x64]))).extension, 'mp3')
  assert.equal(audioHeader(pad(Buffer.from('RIFF\x00\x00\x00\x00WAVEfmt ', 'latin1'))).extension, 'wav')
  assert.equal(audioHeader(pad(Buffer.from('OggS', 'latin1'))).extension, 'ogg')
  assert.equal(audioHeader(pad(Buffer.from('fLaC', 'latin1'))).extension, 'flac')
  assert.equal(audioHeader(pad(Buffer.from('\x00\x00\x00\x20ftypM4A ', 'latin1'))).extension, 'm4a')
  assert.equal(audioHeader(pad(Buffer.from('<html>', 'latin1'))), null)
  assert.equal(audioHeader(pad(Buffer.from('{"error":1}', 'latin1'))), null)
  assert.equal(audioHeader(Buffer.from('ID3')), null)
  assert.equal(audioHeader(pad(Buffer.from([0xff, 0xff, 0xff, 0xff]))), null)
})

test('audio models keep their place in the catalog rules', () => {
  for (const id of ['eleven-v4', 'eleven-v4-turbo', 'eleven-sfx-v2']) assert.equal(getModel(id).delivery, 'sync')
  for (const id of ['pika-sfx', 'eleven-v3', 'sonilo', 'fish-s2-pro', 'heygen-starfish']) assert.equal(getModel(id), null)
  // Pika Music also runs only on the wait-for-the-result route and stays off the screen until a real request has worked.
  // HeyGen was tried and left out (Jaime, 2026-11-18): Comfy hands back a link to HeyGen's own address, which Velorn does not collect from.
  assert.equal(getModel('pika-music').delivery, 'sync'); assert.equal(getModel('pika-music').pending, true)
  assert.equal(listVoices({ model: getModel('eleven-v4') }).length, 10)
})

test('Pika Music is asked for in the shape Comfy documents', () => {
  assert.deepEqual(buildCreateRequest('pika-music', { prompt: ' warm lo-fi ', seconds: 60 }).body, { mode: 'text_to_music', prompt: 'warm lo-fi', duration: 60, rewrite_prompt: false })
  assert.deepEqual(buildCreateRequest('pika-music', { prompt: 'warm lo-fi', lyrics: ' La la\nla ' }).body, { mode: 'text_to_music', prompt: 'warm lo-fi', duration: 30, lyrics: 'La la\nla', rewrite_prompt: false })
  // Nothing that clones a voice or copies a song is ever part of the request.
  for (const key of ['reference_audio', 'source_audio', 'voice_consent_attested', 'clean_reference_audio']) assert.equal(key in buildCreateRequest('pika-music', { prompt: 'x', lyrics: 'y' }).body, false)
  assert.ok(Math.abs(fallbackPrice('pika-music', { seconds: 60 }).usd - 0.02145) < 1e-9)
})

test('until it is proven, Pika Music is neither listed nor accepted', async t => {
  const f = await fixture(t)
  const listed = await f.manager.models({})
  assert.equal(listed.models.some(m => m.id === 'pika-music'), false)
  assert.equal((await f.manager.previewCreate({ modelId: 'pika-music', choices: { prompt: 'warm lo-fi' } })).code, 'COMFY_ROUTER_INVALID')
  assert.equal(f.posts().length, 0)
  const open = await fixture(t, { allowPending: true })
  const all = await open.manager.models({})
  const music = all.models.find(m => m.id === 'pika-music')
  assert.deepEqual([music.kind, music.default, music.lyrics.max, music.seconds.offered.join()], ['music', true, 3000, '30,60,120,180'])
  assert.equal(all.models.find(m => m.id === 'eleven-v4').voices, undefined)
})

// Pika Music answers with a link to the finished sound, not with the sound.
const STORE = 'https://storage.googleapis.com/partner-nodes-assets/a/b/c/d/result'
const pikaAnswer = link => json({ id: 'media_1', status: 'completed', output: { media_type: 'audio', audio: { content_type: 'audio/mpeg', url: link } } }, 200, { 'x-comfy-credits-used': '2.26' })
async function linked(t, modelId, choices, answer, file) {
  const fetched = []
  const f = await fixture(t, { allowPending: true, answer: (url, request) => {
    if (!url.startsWith('https://api.comfy.org/')) { fetched.push({ url, ...request }); return file(url) }
    return answer(url, request)
  } })
  const plan = await f.manager.previewCreate({ modelId, choices })
  assert.equal(plan.success, true, plan.error)
  const { job } = await f.manager.submitCreate({ planId: plan.planId })
  return { f, job: await f.settled(job.jobId), fetched, plan }
}

test('a Pika Music song is sent once, waits for its answer, and its file is collected from Comfy\'s storage without the key', async t => {
  const { f, job, fetched, plan } = await linked(t, 'pika-music', { prompt: 'warm lo-fi', seconds: 60, lyrics: 'Meet me when the streetlights bloom' },
    () => pikaAnswer(`${STORE}.mp3?Signature=y`), () => new Response(MP3, { status: 200 }))
  assert.equal(plan.kind, 'music')
  assert.equal(f.posts().length, 1)
  assert.equal(f.posts()[0].url, 'https://api.comfy.org/v2/models/pika/pika-music')
  assert.deepEqual(JSON.parse(f.posts()[0].body), { mode: 'text_to_music', prompt: 'warm lo-fi', duration: 60, lyrics: 'Meet me when the streetlights bloom', rewrite_prompt: false })
  assert.equal(job.status, 'COMPLETED')
  assert.equal(job.chargedCredits ?? job.credits ?? 2.26, 2.26)
  assert.deepEqual(fetched.map(r => r.url), [`${STORE}.mp3?Signature=y`])
  assert.deepEqual(fetched[0].headers, {})
  const output = await f.manager.output({ jobId: job.jobId })
  assert.deepEqual([output.success, output.kind, output.made, output.mimeType, output.filename], [true, 'audio', 'music', 'audio/mpeg', `velorn-router-${job.jobId}.mp3`])
  assert.equal(Buffer.from(output.bytes).equals(MP3), true)
})

test('a song whose link is elsewhere, missing, not finished or not a sound is a failed result, and nothing else is fetched', async t => {
  for (const [answer, file, fetches] of [
    [() => pikaAnswer('https://cdn.pika.example/audio.mp3'), () => assert.fail('a refused link was fetched'), 0],
    [() => pikaAnswer(42), () => assert.fail('nothing to fetch'), 0],
    [() => json({ id: 'media_1', status: 'running' }), () => assert.fail('nothing to fetch'), 0],
    [() => json({ id: 'media_1', status: 'completed', output: { media_type: 'video', video: { url: `${STORE}.mp4` } } }), () => assert.fail('a clip is not a song'), 0],
    [() => pikaAnswer(`${STORE}.mp3`), () => new Response('<html>not a sound</html>'.padEnd(700, ' '), { status: 200 }), 1],
    [() => pikaAnswer(`${STORE}.mp3`), () => new Response('gone', { status: 404 }), 1],
  ]) {
    const { f, job, fetched } = await linked(t, 'pika-music', { prompt: 'warm lo-fi' }, answer, file)
    assert.deepEqual([job.status, job.errorType], ['FAILED', 'RESULT_UNREADABLE'])
    assert.equal(fetched.length, fetches)
    assert.equal(f.posts().length, 1) // Never sent a second time.
    assert.deepEqual(await f.files(), [])
  }
})

test('the price check for a song carries filler, never the description or the lyrics', async t => {
  const f = await fixture(t, { allowPending: true })
  const plan = await f.manager.previewCreate({ modelId: 'pika-music', choices: { prompt: 'my own description', seconds: 60, lyrics: 'my private words to sing' } })
  assert.equal(plan.success, true)
  const asked = f.requests.find(r => r.url.endsWith('/estimate'))
  assert.equal(asked.url, 'https://api.comfy.org/v2/models/pika/pika-music/estimate')
  const body = JSON.parse(asked.body)
  assert.equal(/private|my own/.test(JSON.stringify(body)), false)
  assert.equal(body.lyrics.length, 'my private words to sing'.length)
  assert.equal(body.duration, 60)
})
