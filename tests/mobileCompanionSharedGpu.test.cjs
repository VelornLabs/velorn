'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createGpuNetworkJobs } = require('../electron/gpuNetworkIpc.cjs')
const { createPhoneSharedGpu } = require('../electron/mobileCompanionSharedGpu.cjs')
const { createMobileCreateBridge } = require('../electron/mobileCompanionCreate.cjs')

// The real job handling and the real phone bridges; only the network client is pretend.
const HOST = 'a'.repeat(32), OTHER = 'b'.repeat(32), T2I = 'own-' + '1'.repeat(16), I2V = 'own-' + '2'.repeat(16)
const png = size => { const b = Buffer.alloc(size, 7); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(b); return b }
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'phone-shared-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const net = { status: 'waiting', progress: null, error: null, submitted: [], cancelled: 0, forgotten: 0, result: png(4000), fail: null,
    hosts: [{ hostId: HOST, name: 'PC', idle: true, sameAccount: false, waiting: 0, workflows: [T2I, I2V], maker: 'chalupa', remainingToday: 2,
      own: [{ id: T2I, name: 'Cartoon houses', shape: 'text-to-picture', kind: 'image', needsImage: false }, { id: I2V, name: 'Moving photo', shape: 'picture-to-video', kind: 'video', needsImage: true }] },
    { hostId: OTHER, name: 'Laptop', idle: false, sameAccount: true, waiting: 1, workflows: [T2I], maker: 'me', own: [{ id: T2I, name: 'My own', shape: 'text-to-picture', kind: 'image', needsImage: false }] }] }
  const client = {
    listHosts: async () => ({ hosts: net.hosts, emailVerified: true, banned: false }),
    submit: async job => { if (net.fail) throw Object.assign(new Error('x'), net.fail); net.submitted.push(job); net.status = 'waiting'; return { jobId: `job-${net.submitted.length}-abcdefgh` } },
    jobStatus: async jobId => { if (net.status === 'gone') throw Object.assign(new Error('gone'), { code: 'GPU_NETWORK_NOT_FOUND' }); return { jobId, status: net.status, ...(net.progress ? { progress: net.progress } : {}), hostOnline: true, ...(net.error ? { error: net.error } : {}) } },
    collect: async jobId => ({ bytes: net.result, mimeType: 'image/png', filename: `velorn-network-${jobId.slice(0, 10)}.png` }),
    cancel: async () => { net.cancelled++; net.status = 'cancelled'; return { cancelled: true } },
    forget: async () => { net.forgotten++ }, reportWorkflow: async () => ({ reported: true }),
  }
  const jobs = createGpuNetworkJobs({ client, jobPath: path.join(dir, 'job.json') })
  const shared = createPhoneSharedGpu({ jobs, cacheDir: path.join(dir, 'shared') })
  const bridge = createMobileCreateBridge({ getManager: () => ({ models: async () => ({ success: true, models: [], buttonApprovalUsd: 2 }), status: async () => ({ success: true, configured: false }) }), cacheDir: path.join(dir, 'create'), shared })
  const events = []; jobs.on(event => events.push(event.type))
  return { dir, net, jobs, bridge, events }
}
const card = (hostId, ownId) => `${hostId}.${ownId}`
async function uploadPhoto(bridge, photoId, bytes) { return bridge.upload({ photoId, index: 0, total: 1, mimeType: 'image/jpeg', data: bytes.toString('base64') }) }

test('the phone is told GPU sharing is there and sees one card per creator workflow, never an address or a computer name', async t => {
  const f = await fixture(t)
  assert.equal((await f.bridge.handle({ action: 'catalog' })).sharedGpu, true)
  const listed = await f.bridge.handle({ action: 'shared-catalog' })
  assert.deepEqual(listed.cards.map(item => [item.name, item.maker, item.kind, item.needsImage, item.ready, item.yours]),
    [['Cartoon houses', 'chalupa', 'image', false, true, false], ['Moving photo', 'chalupa', 'video', true, true, false], ['My own', 'me', 'image', false, false, true]])
  assert.doesNotMatch(JSON.stringify(listed), /"PC"|Laptop|hostName/)
  assert.equal(listed.cards[0].remainingToday, 2)
})

test('a free job from the phone: rules first, then the same job the computer would send, followed, shown and marked saved', async t => {
  const f = await fixture(t)
  await f.bridge.handle({ action: 'shared-catalog' })
  // Someone else's computer: not before the rules were read. One's own needs none.
  assert.equal((await f.bridge.handle({ action: 'shared-send', cardId: card(HOST, T2I), prompt: 'a house' })).code, 'SHARED_RULES')
  assert.equal(f.net.submitted.length, 0)
  const sent = await f.bridge.handle({ action: 'shared-send', cardId: card(HOST, T2I), prompt: '  a cartoon house  ', agreed: true })
  assert.equal(sent.success, true)
  assert.deepEqual([sent.job.label, sent.job.kind, sent.job.maker, sent.job.status], ['Cartoon houses', 'image', 'chalupa', 'waiting'])
  // Exactly the description and nothing else, marked as the phone's so the window follows and saves it.
  assert.deepEqual(f.net.submitted[0], { hostId: HOST, workflowId: T2I, choices: { prompt: 'a cartoon house' }, image: null })
  assert.equal((await f.jobs.current()).job.fromPhone, true)
  assert.ok(f.events.includes('sent'))
  // One at a time, in the network's own words.
  assert.equal((await f.bridge.handle({ action: 'shared-send', cardId: card(OTHER, T2I), prompt: 'another' })).code, 'GPU_NETWORK_ONE_AT_A_TIME')
  f.net.status = 'running'; f.net.progress = 'queued'
  let seen = await f.bridge.handle({ action: 'shared-jobs' })
  assert.deepEqual([seen.busy, seen.jobs[0].status, seen.jobs[0].text], [true, 'running', 'Waiting its turn on that computer…'])
  // Finished: collected for the phone even if the window has not done so, and served by an opaque id.
  f.net.status = 'done'; f.net.progress = null
  // The file is written in the background; the phone simply asks again, as it does every few seconds.
  for (let i = 0; i < 50; i++) { seen = await f.bridge.handle({ action: 'shared-jobs' }); if (seen.jobs[0].ready) break; await new Promise(resolve => setTimeout(resolve, 20)) }
  assert.equal(seen.jobs[0].status, 'done'); assert.equal(seen.jobs[0].ready, true); assert.match(seen.jobs[0].url, /^\/media\/create\/[a-f0-9]{48}$/)
  assert.equal(seen.jobs[0].savedToProject, false)
  const file = await f.bridge.open(seen.jobs[0].url.split('/').pop())
  assert.deepEqual([file.size, file.mime], [4000, 'image/png']); assert.ok((await file.handle.readFile()).equals(f.net.result)); await file.handle.close()
  assert.equal(await f.bridge.open('f'.repeat(48)), null)
  // The window saved it into the project and cleared the job: the phone is told, and still has its picture.
  await f.jobs.forget()
  seen = await f.bridge.handle({ action: 'shared-jobs' })
  assert.deepEqual([seen.busy, seen.jobs[0].savedToProject, seen.jobs[0].ready], [false, true, true])
})

test('a workflow that starts from a picture takes the photo the phone uploaded; without one nothing is sent', async t => {
  const f = await fixture(t)
  await f.bridge.handle({ action: 'shared-catalog' })
  const id = 'c'.repeat(32), photo = Buffer.alloc(3000, 5)
  assert.equal((await f.bridge.handle({ action: 'shared-send', cardId: card(HOST, I2V), prompt: 'it waves', agreed: true })).code, 'CREATE_PHOTO_MISSING')
  assert.equal((await f.bridge.handle({ action: 'shared-send', cardId: card(HOST, I2V), prompt: 'it waves', agreed: true, photoId: id })).code, 'CREATE_PHOTO_MISSING')
  assert.equal((await uploadPhoto(f.bridge, id, photo)).complete, true)
  assert.equal((await f.bridge.handle({ action: 'shared-send', cardId: card(HOST, I2V), prompt: 'it waves', agreed: true, photoId: id })).success, true)
  assert.equal(f.net.submitted[0].image.mimeType, 'image/jpeg'); assert.ok(Buffer.from(f.net.submitted[0].image.bytes).equals(photo))
})

test('only what was just listed can be sent, and refusals, failures and stopping are said plainly', async t => {
  const f = await fixture(t)
  // Nothing listed yet; then ids the list never held, extra fields, an empty or oversized description.
  assert.equal((await f.bridge.handle({ action: 'shared-send', cardId: card(HOST, T2I), prompt: 'x', agreed: true })).code, 'SHARED_UNAVAILABLE')
  await f.bridge.handle({ action: 'shared-catalog' })
  for (const bad of [{ cardId: card('c'.repeat(32), T2I), prompt: 'x', agreed: true }, { cardId: card(HOST, T2I), prompt: '   ', agreed: true }, { cardId: card(HOST, T2I), prompt: 'x'.repeat(2001), agreed: true },
    { cardId: card(HOST, T2I), prompt: 'x', agreed: true, hostId: HOST }, { cardId: card(HOST, T2I), prompt: 'x', agreed: 'yes' }, { cardId: '../etc', prompt: 'x', agreed: true }])
    assert.equal((await f.bridge.handle({ action: 'shared-send', ...bad })).success, false, JSON.stringify(bad))
  assert.equal(f.net.submitted.length, 0)
  // The description check and the daily limit answer in their own words.
  f.net.fail = { code: 'GPU_SHARE_FILTER_EXPLICIT', publicMessage: 'This description is not allowed on the Velorn network.' }
  assert.deepEqual(await f.bridge.handle({ action: 'shared-send', cardId: card(HOST, T2I), prompt: 'x', agreed: true }), { success: false, code: 'GPU_SHARE_FILTER_EXPLICIT', error: 'This description is not allowed on the Velorn network.' })
  f.net.fail = null
  const sent = await f.bridge.handle({ action: 'shared-send', cardId: card(OTHER, T2I), prompt: 'my own computer' }) // One's own computer: no rules step.
  assert.equal(sent.success, true)
  // Stopping needs the job that is really running.
  assert.equal((await f.bridge.handle({ action: 'shared-cancel', jobId: 'some-other-job-id' })).code, 'SHARED_NOT_RUNNING')
  assert.equal((await f.bridge.handle({ action: 'shared-cancel', jobId: sent.job.jobId })).success, true); assert.equal(f.net.cancelled, 1)
  let seen = await f.bridge.handle({ action: 'shared-jobs' })
  assert.deepEqual([seen.jobs[0].status, seen.jobs[0].errorMessage], ['cancelled', 'Stopped.'])
  await f.jobs.forget()
  // A job that fails says why; one the network lost says so.
  const again = await f.bridge.handle({ action: 'shared-send', cardId: card(OTHER, T2I), prompt: 'second' })
  f.net.status = 'failed'; f.net.error = 'That computer went offline.'
  seen = await f.bridge.handle({ action: 'shared-jobs' })
  assert.deepEqual([seen.jobs[0].jobId, seen.jobs[0].status, seen.jobs[0].errorMessage], [again.job.jobId, 'failed', 'That computer went offline.'])
  await f.jobs.forget(); f.net.error = null
  await f.bridge.handle({ action: 'shared-send', cardId: card(OTHER, T2I), prompt: 'third' })
  f.net.status = 'gone'
  seen = await f.bridge.handle({ action: 'shared-jobs' })
  assert.deepEqual([seen.busy, seen.jobs[0].status], [false, 'failed']); assert.match(seen.jobs[0].errorMessage, /no longer on the Velorn network/)
  assert.equal((await f.bridge.handle({ action: 'shared-nope' })).success, false)
})

test('"Yours": this computer\'s own tested workflows show on the phone and run right here, with no network, rules or limit', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'phone-yours-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const MINE = 'own-' + '9'.repeat(16), EDIT = 'own-' + '8'.repeat(16)
  const ran = [], finished = []
  let release, fail = null
  const jobs = createGpuNetworkJobs({ jobPath: path.join(dir, 'job.json'), client: { listHosts: async () => { throw Object.assign(new Error('offline'), { publicMessage: 'The Velorn network could not be reached.' }) },
    submit: async () => { throw new Error('nothing may go to the network') }, jobStatus: async () => ({}), collect: async () => ({}), cancel: async () => ({}), forget: async () => {}, reportWorkflow: async () => ({}) } })
  const shared = createPhoneSharedGpu({ jobs, cacheDir: path.join(dir, 'shared'), onLocalResult: () => finished.push(1),
    local: { list: async () => [{ id: MINE, name: 'My houses', shape: 'text-to-picture', kind: 'image', needsImage: false }, { id: EDIT, name: 'My edit', shape: 'picture-edit', kind: 'image', needsImage: true }, { id: 'not-an-id', name: 'x' }],
      run: job => new Promise((resolve, reject) => { ran.push(job); job.onStatus({ status: 'running' }); job.signal.addEventListener('abort', () => reject(Object.assign(new Error('stopped'), { code: 'GPU_SHARE_STOPPED' })))
        release = () => fail ? reject(Object.assign(new Error('x'), { publicMessage: fail })) : resolve({ mimeType: 'image/png', bytes: png(5000), filename: 'x.png' }) }) } })
  const bridge = createMobileCreateBridge({ getManager: () => ({ models: async () => ({ success: true, models: [] }), status: async () => ({ success: true }) }), cacheDir: path.join(dir, 'create'), shared })
  // Listed even with the network down, first, as the person's own.
  const listed = await bridge.handle({ action: 'shared-catalog' })
  assert.deepEqual(listed.cards.map(item => [item.cardId, item.name, item.maker, item.local, item.ready]), [[`local.${MINE}`, 'My houses', 'Yours', true, true], [`local.${EDIT}`, 'My edit', 'Yours', true, true]])
  // No rules step: it is their own computer. The description goes in as written.
  const sent = await bridge.handle({ action: 'shared-send', cardId: `local.${MINE}`, prompt: ' a red house ' })
  assert.equal(sent.success, true); assert.equal(sent.job.local, true)
  assert.deepEqual([ran[0].id, ran[0].prompt, ran[0].image], [MINE, 'a red house', null])
  let seen = await bridge.handle({ action: 'shared-jobs' })
  assert.deepEqual([seen.busy, seen.jobs[0].status, seen.jobs[0].text], [true, 'running', 'Being made on your computer…'])
  assert.equal((await bridge.handle({ action: 'shared-send', cardId: `local.${MINE}`, prompt: 'another' })).code, 'GPU_NETWORK_ONE_AT_A_TIME')
  assert.equal((await bridge.handle({ action: 'shared-catalog' })).cards[0].ready, false)
  release()
  for (let i = 0; i < 100; i++) { seen = await bridge.handle({ action: 'shared-jobs' }); if (seen.jobs[0].status === 'done') break; await new Promise(resolve => setTimeout(resolve, 10)) }
  assert.deepEqual([seen.busy, seen.jobs[0].status, seen.jobs[0].ready, seen.jobs[0].savedToProject], [false, 'done', true, false])
  const file = await bridge.open(seen.jobs[0].url.split('/').pop()); assert.equal(file.size, 5000); await file.handle.close()
  // The window is told, takes the result once and marks it saved.
  assert.equal(finished.length, 1)
  assert.deepEqual(shared.localResults.pending(), [{ jobId: sent.job.jobId }])
  const taken = await shared.localResults.take(sent.job.jobId)
  assert.deepEqual([taken.mimeType, taken.bytes.length, taken.hostName, taken.prompt], ['image/png', 5000, 'This computer', 'a red house']); assert.match(taken.filename, /^velorn-network-[A-Za-z0-9_-]{1,12}\.png$/)
  assert.equal(shared.localResults.saved(sent.job.jobId), true); assert.deepEqual(shared.localResults.pending(), [])
  assert.equal((await bridge.handle({ action: 'shared-jobs' })).jobs[0].savedToProject, true)
  // A picture workflow needs the phone's photo; stopping and failing are said plainly.
  assert.equal((await bridge.handle({ action: 'shared-send', cardId: `local.${EDIT}`, prompt: 'make it night' })).code, 'CREATE_PHOTO_MISSING')
  await bridge.upload({ photoId: 'd'.repeat(32), index: 0, total: 1, mimeType: 'image/jpeg', data: Buffer.alloc(2000, 4).toString('base64') })
  const edit = await bridge.handle({ action: 'shared-send', cardId: `local.${EDIT}`, prompt: 'make it night', photoId: 'd'.repeat(32) })
  assert.equal(ran[1].image.bytes.length, 2000)
  assert.equal((await bridge.handle({ action: 'shared-cancel', jobId: edit.job.jobId })).success, true)
  for (let i = 0; i < 100; i++) { seen = await bridge.handle({ action: 'shared-jobs' }); if (seen.jobs[0].status === 'cancelled') break; await new Promise(resolve => setTimeout(resolve, 10)) }
  assert.deepEqual([seen.jobs[0].status, seen.jobs[0].errorMessage, seen.busy], ['cancelled', 'Stopped.', false])
  fail = 'ComfyUI could not finish the job.'
  await bridge.handle({ action: 'shared-send', cardId: `local.${MINE}`, prompt: 'third' }); release()
  for (let i = 0; i < 100; i++) { seen = await bridge.handle({ action: 'shared-jobs' }); if (seen.jobs[0].status === 'failed') break; await new Promise(resolve => setTimeout(resolve, 10)) }
  assert.deepEqual([seen.jobs[0].status, seen.jobs[0].errorMessage], ['failed', 'ComfyUI could not finish the job.'])
  // A card that was never listed, or a made-up id, runs nothing.
  assert.equal((await bridge.handle({ action: 'shared-send', cardId: 'local.own-' + '7'.repeat(16), prompt: 'x' })).code, 'SHARED_UNAVAILABLE')
  assert.equal(ran.length, 3)
})
