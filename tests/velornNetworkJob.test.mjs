import test from 'node:test'
import assert from 'node:assert/strict'
import { createVelornNetworkFollower, networkModels, NETWORK_STAGE } from '../src/services/velornNetworkJob.mjs'

const JOB = { jobId: 'job_12345678', hostName: 'Creator Computer', prompt: 'waves' }
// A pretend main process: `steps` are the answers to "current", in order; the last one repeats.
function fake(steps, { collect = { success: true, filename: 'velorn-network-abc.mp4', mimeType: 'video/mp4', bytes: new Uint8Array([1, 2, 3]) } } = {}) {
  const calls = []
  let at = 0
  return { calls, api: {
    current: async () => { calls.push('current'); return steps[Math.min(at++, steps.length - 1)] },
    send: async request => { calls.push(['send', request.hostId]); return { success: true, job: JOB } },
    collect: async () => { calls.push('collect'); return collect },
    forget: async () => { calls.push('forget'); return { success: true } },
    cancel: async () => { calls.push('cancel'); return { success: true } },
  } }
}
const noSleep = async () => {}

test('Velorn offers no workflows of its own: a computer that still lists the old built-in ones gives no card', async () => {
  const { NETWORK_STATE } = await import('../src/services/velornNetworkJob.mjs')
  assert.deepEqual(networkModels([
    { hostId: 'h1', name: 'Creator Computer', sameAccount: true, idle: true, workflows: ['ltx23-i2v', 'ltx23-t2v', 'h3-t2i', 'h3-edit'] },
    { hostId: 'h3', name: 'Other', workflows: ['something-else'] }, null,
  ], { known: ['ltx23-i2v', 'h3-t2i'] }), [])
  assert.deepEqual(networkModels([]), []); assert.deepEqual(networkModels(undefined), [])
  assert.deepEqual(NETWORK_STATE, { ready: 'Ready', busy: 'Busy', unavailable: 'Not available' })
})

test('a job for a creator\'s workflow goes to that creator\'s computer, and some refusals mean "not this one, not now"', async () => {
  const { networkCandidates, tryNextComputer } = await import('../src/services/velornNetworkJob.mjs')
  const cats = { id: 'own-0123456789abcdef', name: 'Cats', shape: 'text-to-picture' }
  const [card] = networkModels([{ hostId: 'h1', name: 'Studio', idle: false, waiting: 2, workflows: [], own: [cats] }])
  assert.deepEqual(networkCandidates(card, cats.id).map(h => [h.hostId, h.idle, h.waiting]), [['h1', false, 2]])
  assert.deepEqual(networkCandidates(card, 'own-ffffffffffffffff'), []); assert.deepEqual(networkCandidates(null, cats.id), [])
  assert.deepEqual(networkCandidates(networkModels([{ hostId: 'h1', name: 'Studio', idle: true, workflows: [], own: [cats], remainingToday: 0 }])[0], cats.id), [], 'today\'s jobs are used up')
  assert.deepEqual(['GPU_NETWORK_HOST_BUSY', 'GPU_NETWORK_HOST_UNAVAILABLE', 'GPU_NETWORK_BANNED', 'GPU_SHARE_FILTER_EXPLICIT', ''].map(tryNextComputer), [true, true, false, false, false])
})

test('a sent job is followed, its clip saved once, and only then cleared from the network', async () => {
  const { api, calls } = fake([
    { success: true, job: JOB, state: { status: 'running', progress: 'running' } },
    { success: true, job: JOB, state: { status: 'done' } },
  ])
  const saved = [], seen = []
  const follower = createVelornNetworkFollower({ getApi: () => api, sleep: noSleep, save: async clip => { saved.push(clip); return { success: true, assetId: 'asset-1' } } })
  follower.subscribe(state => seen.push(state.phase + (state.text ? `:${state.text}` : '')))
  const sent = await follower.send({ hostId: 'h1' })
  assert.equal(sent.success, true)
  await follower.idle()
  assert.equal(saved.length, 1)
  assert.equal(saved[0].jobId, JOB.jobId); assert.equal(saved[0].hostName, 'Creator Computer'); assert.equal(saved[0].prompt, 'waves')
  assert.deepEqual(follower.state(), { phase: 'done', job: JOB, assetId: 'asset-1' })
  assert.ok(calls.indexOf('forget') > calls.indexOf('collect'))
  assert.ok(seen.includes(`running:${NETWORK_STAGE.running}`) && seen.includes('saving'))
  follower.clear()
  assert.equal(follower.state().phase, 'idle')
})

test('a save that fails is tried again without fetching the clip twice, and nothing is cleared until it works', async () => {
  const { api, calls } = fake([{ success: true, job: JOB, state: { status: 'done' } }])
  let tries = 0
  const follower = createVelornNetworkFollower({ getApi: () => api, sleep: noSleep, save: async () => (++tries < 3 ? { success: false, retry: true, error: 'Wait for the export to finish, then save the clip.' } : { success: true, assetId: 'a' }) })
  await follower.resume()
  assert.equal(tries, 3)
  assert.equal(calls.filter(call => call === 'collect').length, 1)
  assert.equal(calls.filter(call => call === 'forget').length, 1)
  assert.equal(follower.state().phase, 'done')
})

test('with no project open the clip is not fetched; it waits', async () => {
  const { api, calls } = fake([{ success: true, job: JOB, state: { status: 'done' } }])
  let open = false, looks = 0
  const follower = createVelornNetworkFollower({ getApi: () => api, hasProject: () => open, save: async () => ({ success: true, assetId: 'a' }),
    sleep: async () => { if (++looks === 2) { assert.equal(calls.includes('collect'), false); assert.match(follower.state().text, /Open a project/); open = true } } })
  await follower.resume()
  assert.equal(follower.state().phase, 'done')
})

test('a failed or cancelled job is cleared and reported; a vanished one too', async () => {
  const failed = fake([{ success: true, job: JOB, state: { status: 'failed', error: 'The other computer ran out of memory.' } }])
  const one = createVelornNetworkFollower({ getApi: () => failed.api, sleep: noSleep, save: async () => assert.fail('nothing to save') })
  await one.resume()
  assert.deepEqual(one.state(), { phase: 'failed', job: JOB, cancelled: false, error: 'The other computer ran out of memory.' })
  assert.ok(failed.calls.includes('forget'))

  const stopped = fake([{ success: true, job: JOB, state: { status: 'cancelled' } }])
  const two = createVelornNetworkFollower({ getApi: () => stopped.api, sleep: noSleep, save: async () => ({}) })
  await two.resume()
  assert.equal(two.state().cancelled, true)

  const gone = fake([{ success: true, job: JOB, state: { status: 'running' } }, { success: true, job: null, lost: JOB }])
  const three = createVelornNetworkFollower({ getApi: () => gone.api, sleep: noSleep, save: async () => ({}) })
  await three.resume()
  assert.equal(three.state().phase, 'failed'); assert.match(three.state().error, /no longer on the Velorn network/)
})

test('nothing in flight: resume is quiet, and a second job cannot be sent over a running one', async () => {
  const quiet = fake([{ success: true, job: null }])
  const idle = createVelornNetworkFollower({ getApi: () => quiet.api, sleep: noSleep, save: async () => ({}) })
  await idle.resume()
  assert.deepEqual(idle.state(), { phase: 'idle' })
  assert.deepEqual(createVelornNetworkFollower({ getApi: () => null, save: async () => ({}) }).state(), { phase: 'idle' })

  let release
  const busy = fake([{ success: true, job: JOB, state: { status: 'running' } }])
  const follower = createVelornNetworkFollower({ getApi: () => busy.api, save: async () => ({}), sleep: () => new Promise(resolve => { release = resolve }) })
  assert.equal((await follower.send({ hostId: 'h1' })).success, true)
  const second = await follower.send({ hostId: 'h1' })
  assert.equal(second.success, false); assert.match(second.error, /already have a job/)
  assert.equal(busy.calls.filter(call => Array.isArray(call)).length, 1)
  void release
})

test('a refused send leaves nothing behind', async () => {
  const { api } = fake([{ success: true, job: null }])
  api.send = async () => ({ success: false, error: 'That computer is not sharing right now.' })
  const follower = createVelornNetworkFollower({ getApi: () => api, sleep: noSleep, save: async () => ({}) })
  assert.deepEqual(await follower.send({ hostId: 'h1' }), { success: false, error: 'That computer is not sharing right now.' })
  assert.equal(follower.state().phase, 'idle')
})

test('a picture job is followed like a clip, but the words say picture', async () => {
  const job = { ...JOB, workflowId: 'own-0123456789abcdef', kind: 'image' }
  const { api } = fake([{ success: true, job, state: { status: 'running', progress: 'collecting' } }, { success: true, job, state: { status: 'done' } }],
    { collect: { success: true, filename: 'velorn-network-abc.png', mimeType: 'image/png', bytes: new Uint8Array([1, 2, 3]) } })
  api.send = async () => ({ success: true, job })
  const seen = [], saved = []
  const follower = createVelornNetworkFollower({ getApi: () => api, sleep: noSleep, save: async file => { saved.push(file); return { success: true, assetId: 'asset-1' } } })
  follower.subscribe(state => { if (state.text) seen.push(state.text) })
  await follower.send({ hostId: 'h2' }); await follower.idle()
  assert.ok(seen.includes('Almost done. The picture is on its way back.'), seen.join(' | '))
  assert.deepEqual([saved[0].mimeType, saved[0].filename, follower.state().phase], ['image/png', 'velorn-network-abc.png', 'done'])
})

test('a creator\'s own workflow is its own line with the maker\'s name, and lives on that creator\'s computer', async () => {
  const { networkCandidates, jobKind } = await import('../src/services/velornNetworkJob.mjs')
  const cats = { id: 'own-0123456789abcdef', name: 'Sam\'s cats', shape: 'picture-edit' }
  const models = networkModels([
    { hostId: 'h1', name: 'Studio PC', maker: 'Sam', idle: true, workflows: ['ltx23-i2v'], own: [cats, { id: 'own-fedcba9876543210', name: 'City flyover', shape: 'text-to-video' }, { id: 'own-0000000000000000', name: 'Odd', shape: 'four-pictures' }], remainingToday: 3 },
    { hostId: 'h2', name: 'Other PC', idle: false, workflows: [], own: [{ id: 'own-1111111111111111', name: 'Product shots', shape: 'text-to-picture' }] },
  ])
  assert.deepEqual(models.map(m => [m.name, m.kind, m.state, m.own === true]), [['Sam\'s cats', 'image', 'ready', true], ['City flyover', 'video', 'ready', true], ['Product shots', 'image', 'busy', true]])
  const [mine, , theirs] = models
  assert.deepEqual([mine.id, mine.ownId, mine.maker, mine.needsImage, mine.note], ['network-own:h1:own-0123456789abcdef', cats.id, 'Sam', true, 'By Sam. Changes a picture you add. Free, on their shared GPU.'])
  assert.match(theirs.note, /^By A Velorn creator\. .*Busy right now/)
  assert.equal(/Studio PC|Other PC/.test(models.map(m => m.name + m.note).join(' ')), false, 'no computer is named before the job')
  assert.deepEqual(networkCandidates(mine, cats.id).map(h => h.hostId), ['h1']); assert.deepEqual(networkCandidates(mine, 'own-1111111111111111'), [])
  assert.equal(networkModels([{ hostId: 'h1', maker: 'Sam', idle: true, workflows: [], own: [cats], remainingToday: 0 }])[0].state, 'unavailable')
  assert.deepEqual([jobKind({ workflowId: cats.id, kind: 'image' }), jobKind({ workflowId: cats.id, kind: 'video' }), jobKind({ workflowId: 'h3-edit' }), jobKind({ workflowId: 'ltx23-i2v' })], ['image', 'video', 'image', 'video'])
})

test('a creator\'s music workflow is a music card that takes lyrics, and its job speaks of a song', async () => {
  const songs = { id: 'own-0123456789abcdef', name: 'Stadium songs', shape: 'text-to-music' }
  const [card] = networkModels([{ hostId: 'h1', name: 'Studio', idle: true, workflows: [], own: [songs], maker: 'Sam' }])
  assert.deepEqual([card.kind, card.needsImage, card.lyrics, card.sizes, card.resolutions, card.ownId], ['music', false, { max: 3000 }, undefined, undefined, songs.id])
  assert.match(card.note, /By Sam\. Makes music from your description\. Add lyrics to have them sung\./)
  const { jobKind } = await import('../src/services/velornNetworkJob.mjs')
  assert.equal(jobKind({ kind: 'music', workflowId: songs.id }), 'music')
  assert.equal(jobKind({ workflowId: songs.id }), 'video') // An older record without a kind keeps its old meaning.
})

test('a music card offers half a minute to four minutes and starts on two', async () => {
  const { MUSIC_LENGTHS } = await import('../src/services/velornNetworkJob.mjs')
  const { fitOptions, lengthLabel, footnote } = await import('../src/services/createFlow.mjs')
  assert.deepEqual(MUSIC_LENGTHS, [30, 60, 90, 120, 150, 180, 210, 240])
  const [card] = networkModels([{ hostId: 'h1', name: 'Studio', idle: true, workflows: [], own: [{ id: 'own-0123456789abcdef', name: 'Songs', shape: 'text-to-music' }] }])
  assert.deepEqual(card.seconds, { offered: MUSIC_LENGTHS, initial: 120 })
  assert.deepEqual([fitOptions(card, {}).seconds, fitOptions(card, { seconds: 210 }).seconds, fitOptions(card, { seconds: 45 }).seconds], [120, 210, 120])
  assert.deepEqual(MUSIC_LENGTHS.map(lengthLabel), ['30 sec', '1 min', '1.5 min', '2 min', '2.5 min', '3 min', '3.5 min', '4 min'])
  assert.match(footnote({ model: card }), /description and lyrics travel/)
})
