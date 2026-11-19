'use strict'
// The Velorn side of the Velorn network: the content check, the bounded call to
// the queue, the client's refusals, and the window's send / follow / collect
// channels. The two real ends are run together in the connection service's own
// tests; here the queue is pretend.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { once } = require('node:events')
const { checkPrompt } = require('../electron/gpuShareFilter.cjs')
const { requestGpuNetwork, MAX_RESPONSE } = require('../electron/gpuNetworkTransport.cjs')
const { createGpuShareClient } = require('../electron/gpuShareClient.cjs')
const { registerGpuNetworkIpc, CHANNELS } = require('../electron/gpuNetworkIpc.cjs')

const png = size => { const b = Buffer.alloc(size, 7); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(b); return b }
const mp4 = size => { const b = Buffer.alloc(size, 9); b.write('ftypisom', 4, 'ascii'); return b }
const HOST = 'a'.repeat(32), TOKEN = 't'.repeat(43)

test('the content check refuses explicit descriptions, however they are spelled, and lets ordinary ones through', () => {
  for (const prompt of ['Waves rolling in at dusk', 'A child flying a kite on the beach', 'A strip of land by the sea', 'Sussex coastline at dawn', 'A cockatoo on a branch', 'a b c blocks on a table', 'Middlesex county fair'])
    assert.deepEqual(checkPrompt(prompt), { ok: true }, prompt)
  for (const prompt of ['a nude figure', 'N U D E figure', 'A n.u.d.e figure on a beach', 'nak3d person', 'NSFW scene', 'p0rn', 'Two people having sex', 'ṅúde woman'])
    assert.equal(checkPrompt(prompt).code, 'GPU_SHARE_FILTER_EXPLICIT', prompt)
  for (const prompt of ['a naked child', 'sexy teen', 'school girl, s e x y'])
    assert.deepEqual(checkPrompt(prompt), { ok: false, code: 'GPU_SHARE_FILTER_MINOR', reason: 'This description is not allowed on the Velorn network.' }, prompt)
  // Revealing clothes or a flirty mood, the level of a music video, are allowed; with a minor they are not.
  for (const prompt of ['A sexy dancer in a bikini on stage', 'A woman in lingerie with a seductive look', 'Kids in swimsuits at the beach'])
    assert.deepEqual(checkPrompt(prompt), { ok: true }, prompt)
  for (const prompt of ['a seductive schoolgirl', 'teen in lingerie'])
    assert.equal(checkPrompt(prompt).code, 'GPU_SHARE_FILTER_MINOR', prompt)
  // The reason never repeats what was written.
  assert.doesNotMatch(checkPrompt('a nude figure in Lisbon').reason, /Lisbon|nude/)
  assert.equal(checkPrompt('   ').ok, false); assert.equal(checkPrompt(null).ok, false)
})

test('a call to the queue goes only to the fixed routes, with the computer credential, and is bounded', async t => {
  const seen = []
  let answer = (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true,"hosts":[]}') }
  const server = http.createServer((req, res) => { let body = ''; req.on('data', chunk => { body += chunk }); req.on('end', () => { seen.push({ url: req.url, auth: req.headers.authorization, body }); answer(req, res) }) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const url = route => new URL(`/account/desktop/gpu/${route}`, `http://127.0.0.1:${server.address().port}`)
  assert.deepEqual(await requestGpuNetwork({ url: url('hosts'), token: TOKEN, body: { computerId: 'c' }, allowLocalTest: true }), { ok: true, hosts: [] })
  assert.deepEqual(seen[0], { url: '/account/desktop/gpu/hosts', auth: `Bearer ${TOKEN}`, body: '{"computerId":"c"}' })
  // A refusal by the service is an answer, not an exception.
  answer = (req, res) => { res.writeHead(429, { 'content-type': 'application/json' }); res.end('{"ok":false,"error":"daily_limit"}') }
  assert.deepEqual(await requestGpuNetwork({ url: url('submit'), token: TOKEN, body: {}, allowLocalTest: true }), { ok: false, error: 'daily_limit', status: 429 })
  const sent = seen.length
  // Never sent: plain http without the local-test switch, another path, a query, a bad credential, too much.
  await assert.rejects(requestGpuNetwork({ url: url('hosts'), token: TOKEN, body: {} }), { code: 'GPU_NETWORK_REJECTED' })
  await assert.rejects(requestGpuNetwork({ url: new URL('/account/desktop/luna/respond', url('hosts')), token: TOKEN, body: {}, allowLocalTest: true }), { code: 'GPU_NETWORK_REJECTED' })
  await assert.rejects(requestGpuNetwork({ url: new URL('?x=1', url('hosts')), token: TOKEN, body: {}, allowLocalTest: true }), { code: 'GPU_NETWORK_REJECTED' })
  await assert.rejects(requestGpuNetwork({ url: url('hosts'), token: 'short', body: {}, allowLocalTest: true }), { code: 'GPU_NETWORK_REJECTED' })
  await assert.rejects(requestGpuNetwork({ url: url('job/input'), token: TOKEN, body: { data: 'x'.repeat(301 * 1024) }, allowLocalTest: true }), { code: 'GPU_NETWORK_LIMIT' })
  assert.equal(seen.length, sent)
  // An answer that is too large or not JSON is not trusted.
  answer = (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, data: 'x'.repeat(MAX_RESPONSE) })) }
  await assert.rejects(requestGpuNetwork({ url: url('hosts'), token: TOKEN, body: {}, allowLocalTest: true }), { code: 'GPU_NETWORK_UNAVAILABLE' })
  answer = (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<p>hello</p>') }
  await assert.rejects(requestGpuNetwork({ url: url('hosts'), token: TOKEN, body: {}, allowLocalTest: true }), { code: 'GPU_NETWORK_UNAVAILABLE' })
})

function client({ replies = {}, settings = {}, run, jobLog = null } = {}) {
  const calls = []
  const chosen = { enabled: true, allowedWorkflows: ['ltx23-i2v'], invited: [], askBeforeEach: true, dailyLimitPerPerson: 2, ...settings }
  const made = createGpuShareClient({ jobLog,
    host: { getSettings: async () => ({ ...chosen }), idle: async () => ({ idle: true, reasons: [] }), status: async () => ({ offering: chosen.enabled ? chosen.allowedWorkflows : [] }) },
    runner: { run: run || (async () => ({ mimeType: 'video/mp4', bytes: mp4(4000) })) },
    getNetwork: () => ({ request: async (route, payload) => { calls.push({ route, payload }); const reply = replies[route]; return typeof reply === 'function' ? reply(payload) : reply || { ok: true } } }) })
  return { made, calls, chosen }
}

test('the sender checks a job before anything leaves, and says plainly why the queue refused', async () => {
  const good = { hostId: HOST, workflowId: 'ltx23-i2v', choices: { prompt: 'Waves at dusk' }, image: { mimeType: 'image/png', bytes: png(4000) } }
  const c = client({ replies: { submit: { ok: true, jobId: 'job-12345678' } } })
  assert.deepEqual(await c.made.submit(good), { jobId: 'job-12345678' })
  assert.deepEqual(c.calls.map(call => call.route), ['submit', 'job/input'])
  assert.deepEqual(c.calls[0].payload, { hostId: HOST, workflowId: 'ltx23-i2v', choices: { prompt: 'Waves at dusk', shape: 'landscape', size: '720p', seconds: 5 }, image: { mimeType: 'image/png', bytes: 4000, pieces: 1 } })
  const none = client()
  await assert.rejects(none.made.submit({ ...good, workflowId: 'my-own-workflow' }), { code: 'GPU_SHARE_WORKFLOW_UNKNOWN' })
  await assert.rejects(none.made.submit({ ...good, choices: { prompt: 'a nude figure' } }), { code: 'GPU_SHARE_FILTER_EXPLICIT' })
  await assert.rejects(none.made.submit({ ...good, choices: { prompt: 'Waves', seconds: 60 } }))
  await assert.rejects(none.made.submit({ ...good, image: { mimeType: 'image/png', bytes: Buffer.from('<html>not a picture</html>') } }))
  await assert.rejects(none.made.submit({ ...good, hostId: 'https://example.com' }))
  assert.equal(none.calls.length, 0)
  for (const [error, words] of [['daily_limit', /today/], ['one_at_a_time', /already have a job/], ['host_unavailable', /not available/], ['unauthorized', /Sign in/], ['something_new', /could not do that/]])
    await assert.rejects(client({ replies: { submit: { ok: false, error } } }).made.submit(good), error => words.test(error.publicMessage))
  // A picture that cannot be delivered: the job is withdrawn, not left waiting.
  const broken = client({ replies: { submit: { ok: true, jobId: 'job-12345678' }, 'job/input': { ok: false, error: 'too_large' } } })
  await assert.rejects(broken.made.submit(good), { code: 'GPU_NETWORK_TOO_LARGE' })
  assert.deepEqual(broken.calls.map(call => call.route), ['submit', 'job/input', 'job/cancel', 'job/done'])
})

test('a clip that comes back is checked before it is handed on', async () => {
  const clip = mp4(5000)
  const done = output => ({ ok: true, status: 'done', output })
  const good = client({ replies: { 'job/status': done({ mimeType: 'video/mp4', bytes: 5000, pieces: 1 }), 'job/output': { ok: true, data: clip.toString('base64') } } })
  const got = await good.made.collect('job-12345678')
  assert.ok(got.bytes.equals(clip)); assert.equal(got.filename, 'velorn-network-job-123456.mp4')
  assert.equal(good.calls.at(-1).route, 'job/done')
  for (const [name, replies] of Object.entries({
    'not a video type': { 'job/status': done({ mimeType: 'application/x-sh', bytes: 5000, pieces: 1 }) },
    'wrong piece count': { 'job/status': done({ mimeType: 'video/mp4', bytes: 5000, pieces: 3 }) },
    'too large': { 'job/status': done({ mimeType: 'video/mp4', bytes: 200 * 1024 * 1024, pieces: 1042 }) },
    'not really a video': { 'job/status': done({ mimeType: 'video/mp4', bytes: 5000, pieces: 1 }), 'job/output': { ok: true, data: Buffer.alloc(5000, 1).toString('base64') } },
    'shorter than promised': { 'job/status': done({ mimeType: 'video/mp4', bytes: 5000, pieces: 1 }), 'job/output': { ok: true, data: mp4(900).toString('base64') } },
  })) await assert.rejects(client({ replies }).made.collect('job-12345678'), { code: 'GPU_NETWORK_INVALID' }, name)
  await assert.rejects(client({ replies: { 'job/status': { ok: true, status: 'running' } } }).made.collect('job-12345678'), { code: 'GPU_NETWORK_NOT_READY' })
})

test('a host turns down what its owner did not allow, without running anything', async () => {
  const offer = extra => ({ ok: true, hostId: HOST, cancelled: [], job: { jobId: 'job-12345678', workflowId: 'ltx23-i2v', choices: { prompt: 'Waves at dusk' }, image: { mimeType: 'image/png', bytes: 4000, pieces: 1 }, requester: { sameAccount: true }, ...extra } })
  const settle = async c => { for (let i = 0; i < 200 && c.made.hostState().job; i++) await new Promise(resolve => setTimeout(resolve, 5)) }
  for (const [name, extra, settings] of [
    ['a workflow that is not Velorn\'s', { workflowId: 'someones-own' }, {}],
    ['a workflow the owner did not tick', {}, { allowedWorkflows: [] }],
    ['choices outside what the workflow takes', { choices: { prompt: 'Waves', seconds: 600 } }, {}],
    ['an extra instruction smuggled into the choices', { choices: { prompt: 'Waves', workflow: { 1: {} } } }, {}],
    ['a picture that is too large', { image: { mimeType: 'image/png', bytes: 50 * 1024 * 1024, pieces: 261 } }, {}],
    ['a file that is not a picture type', { image: { mimeType: 'application/zip', bytes: 4000, pieces: 1 } }, {}],
    ['someone else\'s job nobody approved', { requester: { sameAccount: false, email: 'friend@example.test' } }, {}],
  ]) {
    let ran = 0
    const c = client({ replies: { 'host/heartbeat': offer(extra) }, settings, run: async () => { ran++; return { mimeType: 'video/mp4', bytes: mp4(4000) } } })
    c.chosen.allowedWorkflows = settings.allowedWorkflows || ['ltx23-i2v']
    // The heartbeat still offers the workflow; the job itself is what is refused.
    await c.made.beat(); await settle(c)
    assert.equal(ran, 0, name)
    assert.deepEqual(c.calls.filter(call => call.route === 'host/claim').map(call => call.payload), [{ jobId: 'job-12345678', accept: false }], name)
    assert.equal(c.made.hostState().lastJob.outcome, 'declined', name)
  }
  // A picture whose bytes are not what it claims is refused after download, and the requester is told.
  let ran = 0
  const fake = client({ replies: { 'host/heartbeat': offer({}), 'host/input': { ok: true, data: Buffer.alloc(4000, 3).toString('base64') } }, run: async () => { ran++ } })
  await fake.made.beat(); await settle(fake)
  assert.equal(ran, 0)
  assert.deepEqual(fake.calls.at(-1), { route: 'host/finish', payload: { jobId: 'job-12345678', ok: false, error: 'host_failed' } })
  // Signed out: nothing is sent and the panel says why.
  const signedOut = createGpuShareClient({ host: { getSettings: async () => ({ enabled: true, allowedWorkflows: [] }), idle: async () => ({ idle: true, reasons: [] }), status: async () => ({ offering: [] }) }, runner: { run: async () => {} }, getNetwork: () => null })
  assert.deepEqual(await signedOut.beat().then(state => ({ connected: state.connected, note: state.note })), { connected: false, note: 'Sign in to your Velorn account on this computer first.' })
})

test('a host keeps the last jobs other people sent, and can report one to the service', async () => {
  const offer = requester => ({ ok: true, hostId: HOST, cancelled: [], job: { jobId: 'job-12345678', workflowId: 'ltx23-i2v', choices: { prompt: 'Waves at dusk' }, image: { mimeType: 'image/png', bytes: 4000, pieces: 1 }, requester } })
  const settle = async c => { for (let i = 0; i < 200 && (c.made.hostState().job || !c.made.hostState().lastJob); i++) await new Promise(resolve => setTimeout(resolve, 5)) }
  const replies = requester => ({ 'host/heartbeat': offer(requester), 'host/input': { ok: true, data: png(4000).toString('base64') } })
  // The person's own computer: nothing to report.
  const own = client({ replies: replies({ sameAccount: true }) })
  await own.made.beat(); await settle(own)
  assert.equal(own.made.hostState().lastJob.outcome, 'done'); assert.deepEqual(own.made.hostState().recent, [])
  // Someone invited: the job is listed with who sent it and what they wrote.
  const c = client({ replies: replies({ sameAccount: false, email: 'friend@example.test' }), settings: { askBeforeEach: false } })
  await c.made.beat(); await settle(c)
  const [listed] = c.made.hostState().recent
  assert.deepEqual({ ...listed, at: 0 }, { jobId: 'job-12345678', from: 'friend@example.test', prompt: 'Waves at dusk', outcome: 'done', at: 0, reported: false, hasFiles: false })
  await assert.rejects(c.made.report('job-somethingelse'), { code: 'GPU_SHARE_INVALID' })
  assert.deepEqual(await c.made.report('job-12345678'), { reported: true })
  assert.deepEqual(c.calls.at(-1), { route: 'host/report', payload: { jobId: 'job-12345678', reason: 'explicit' } })
  assert.equal(c.made.hostState().recent[0].reported, true)
  // The service says no: the job stays unreported and the person is told.
  const refused = client({ replies: { ...replies({ sameAccount: false, email: 'friend@example.test' }), 'host/report': { ok: false, error: 'unavailable' } }, settings: { askBeforeEach: false } })
  await refused.made.beat(); await settle(refused)
  await assert.rejects(refused.made.report('job-12345678'), { code: 'GPU_NETWORK_UNAVAILABLE' })
  assert.equal(refused.made.hostState().recent[0].reported, false)
})

test('the host keeps the picture and clip of other people\'s last jobs, lists them again after a restart, and drops old ones', async t => {
  const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path')
  const { createGpuShareJobLog } = require('../electron/gpuShareJobLog.cjs')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-job-log-')); t.after(() => fs.rm(dir, { recursive: true, force: true }))
  let time = 1_800_000_000_000
  const log = createGpuShareJobLog({ dir, keep: 2, now: () => time })
  const offer = { ok: true, hostId: HOST, cancelled: [], job: { jobId: 'job-12345678', workflowId: 'ltx23-i2v', choices: { prompt: 'Waves at dusk' }, image: { mimeType: 'image/png', bytes: 4000, pieces: 1 }, requester: { sameAccount: false, email: 'friend@example.test' } } }
  const c = client({ jobLog: log, replies: { 'host/heartbeat': offer, 'host/input': { ok: true, data: png(4000).toString('base64') } }, settings: { askBeforeEach: false } })
  await c.made.beat(); for (let i = 0; i < 200 && (c.made.hostState().job || !c.made.hostState().lastJob); i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(c.made.hostState().recent[0].hasFiles, true)
  const folder = await log.folder('job-12345678')
  assert.deepEqual((await fs.readdir(folder)).sort(), ['clip.mp4', 'job.json', 'picture.png'])
  assert.deepEqual(await fs.readFile(path.join(folder, 'picture.png')), png(4000)); assert.deepEqual(await fs.readFile(path.join(folder, 'clip.mp4')), mp4(4000))
  await c.made.report('job-12345678')
  // A new run of Velorn reads the list back, reported mark included.
  const again = client({ jobLog: createGpuShareJobLog({ dir, keep: 2, now: () => time }) })
  for (let i = 0; i < 100 && !again.made.hostState().recent.length; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(again.made.hostState().recent.map(item => [item.jobId, item.from, item.reported, item.hasFiles]), [['job-12345678', 'friend@example.test', true, true]])
  // A declined job has no files; only the newest few are kept; nothing outlives thirty days.
  time += 1000; await log.save({ jobId: 'job-declined1', from: 'friend@example.test', prompt: 'x', outcome: 'declined' })
  assert.equal(await log.folder('job-declined1'), null)
  time += 1000; await log.save({ jobId: 'job-third0001', from: 'a@example.test', prompt: 'y', outcome: 'done', clip: { mimeType: 'video/mp4', bytes: mp4(100) } })
  assert.deepEqual((await log.list()).map(item => item.jobId), ['job-third0001', 'job-declined1'])
  assert.deepEqual((await fs.readdir(dir)).sort(), ['job-declined1', 'job-third0001'])
  assert.equal(await log.folder('../job-third0001'), null); assert.equal(await log.folder('job-12345678'), null)
  time += 31 * 86400000
  assert.deepEqual(await log.list(), []); assert.deepEqual(await fs.readdir(dir), [])
})

test('the window can send one job at a time, follow it after a restart, and clears it only when told', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'velorn-gpu-network-')); t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const jobPath = path.join(dir, 'gpu-network-job.json')
  const log = []
  let status = { jobId: 'job-12345678', status: 'running', hostOnline: true }
  const fakeClient = {
    listHosts: async () => ({ hosts: [], emailVerified: true }),
    submit: async job => { log.push(['submit', job.workflowId, Buffer.isBuffer(job.image.bytes), job.image.bytes.length]); return { jobId: 'job-12345678' } },
    jobStatus: async () => { if (!status) throw Object.assign(new Error('gone'), { code: 'GPU_NETWORK_NOT_FOUND' }); return status },
    cancel: async () => ({ status: 'running', cancelRequested: true }),
    collect: async (jobId, options) => { log.push(['collect', jobId, options]); return { bytes: mp4(3000), mimeType: 'video/mp4', filename: 'velorn-network-job-123456.mp4' } },
    forget: async jobId => { log.push(['forget', jobId]) } }
  const open = () => {
    const handlers = new Map(), webContents = { mainFrame: {} }
    const ipc = registerGpuNetworkIpc({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) },
      getMainWindow: () => ({ isDestroyed: () => false, webContents }), client: fakeClient, jobPath, now: () => 1_800_000_000_000 })
    const event = { sender: webContents, senderFrame: webContents.mainFrame }
    return { ipc, handlers, call: (channel, payload) => handlers.get(`gpu-network:${channel}`)(event, payload) }
  }
  let window = open()
  assert.deepEqual([...window.handlers.keys()].sort(), [...CHANNELS].sort())
  // Another frame or window gets nothing.
  assert.equal((await window.handlers.get('gpu-network:hosts')({ sender: {}, senderFrame: {} })).success, false)
  assert.deepEqual(await window.call('current'), { success: true, job: null })
  const job = { hostId: HOST, hostName: 'Studio 5090', workflowId: 'ltx23-i2v', choices: { prompt: 'Waves at dusk' }, image: { mimeType: 'image/png', bytes: new Uint8Array(png(4000)) } }
  assert.equal((await window.call('send', { ...job, image: { mimeType: 'image/png', bytes: 'not bytes' } })).success, false)
  const sent = await window.call('send', job)
  assert.deepEqual(sent.job, { jobId: 'job-12345678', hostId: HOST, hostName: 'Studio 5090', workflowId: 'ltx23-i2v', prompt: 'Waves at dusk', sentAt: 1_800_000_000_000 })
  assert.deepEqual(log[0], ['submit', 'ltx23-i2v', true, 4000])
  assert.equal((await fs.stat(jobPath)).mode & 0o777, 0o600)
  assert.match((await window.call('send', job)).error, /already have a job/)
  // Velorn restarts: the job is still followed.
  window.ipc.dispose(); window = open()
  assert.deepEqual((await window.call('current')).state, status)
  assert.equal((await window.call('cancel')).cancelRequested, true)
  status = { jobId: 'job-12345678', status: 'done', hostOnline: true }
  const clip = await window.call('collect')
  assert.equal(clip.success, true); assert.ok(clip.bytes instanceof Uint8Array); assert.equal(clip.bytes.length, 3000)
  assert.deepEqual(log.at(-1), ['collect', 'job-12345678', { keep: true }]) // Kept on the queue until the project has it.
  assert.equal((await window.call('current')).job.jobId, 'job-12345678')
  assert.deepEqual(await window.call('forget'), { success: true, job: null })
  assert.deepEqual(log.at(-1), ['forget', 'job-12345678'])
  await assert.rejects(fs.stat(jobPath), { code: 'ENOENT' })
  // A job the queue no longer knows is dropped instead of blocking the next one.
  await window.call('send', job); status = null
  const lost = await window.call('current')
  assert.equal(lost.job, null); assert.equal(lost.lost.jobId, 'job-12345678')
  assert.equal((await window.call('send', job)).success, true)
})

test('a picture workflow sends no picture for text to image, runs on a host without one, and its PNG is checked on the way back', async () => {
  // Sender: text to image goes out with a description and a shape only.
  const c = client({ replies: { submit: { ok: true, jobId: 'job-12345678' } } })
  assert.deepEqual(await c.made.submit({ hostId: HOST, workflowId: 'h3-t2i', choices: { prompt: 'A lighthouse', shape: 'portrait' } }), { jobId: 'job-12345678' })
  assert.deepEqual(c.calls.map(call => call.route), ['submit'])
  assert.deepEqual(c.calls[0].payload, { hostId: HOST, workflowId: 'h3-t2i', choices: { prompt: 'A lighthouse', shape: 'portrait' } })
  const none = client()
  await assert.rejects(none.made.submit({ hostId: HOST, workflowId: 'h3-t2i', choices: { prompt: 'A lighthouse' }, image: { mimeType: 'image/png', bytes: png(4000) } }), { code: 'GPU_SHARE_INVALID' })
  await assert.rejects(none.made.submit({ hostId: HOST, workflowId: 'h3-edit', choices: { prompt: 'Make it night' } }))
  await assert.rejects(none.made.submit({ hostId: HOST, workflowId: 'h3-t2i', choices: { prompt: 'A lighthouse', seconds: 5 } }), { code: 'GPU_SHARE_INVALID' })
  assert.equal(none.calls.length, 0)
  // Host: the job arrives without a picture, runs, and the PNG goes back.
  const settle = async made => { for (let i = 0; i < 200 && made.hostState().job; i++) await new Promise(resolve => setTimeout(resolve, 5)) }
  const offer = extra => ({ ok: true, hostId: HOST, cancelled: [], job: { jobId: 'job-12345678', workflowId: 'h3-t2i', choices: { prompt: 'A lighthouse' }, image: null, requester: { sameAccount: true }, ...extra } })
  let got = null
  const host = client({ replies: { 'host/heartbeat': offer({}), 'host/claim': { ok: true } }, settings: { allowedWorkflows: ['h3-t2i'] }, run: async job => { got = job; return { mimeType: 'image/png', bytes: png(6000) } } })
  await host.made.beat(); await settle(host.made)
  assert.deepEqual([got.workflowId, got.image, got.choices], ['h3-t2i', null, { prompt: 'A lighthouse', shape: 'square', seed: null }])
  assert.equal(host.calls.some(call => call.route === 'host/input'), false)
  assert.deepEqual(host.calls.find(call => call.route === 'host/output').payload.file, { mimeType: 'image/png', bytes: 6000, pieces: 1 })
  assert.deepEqual(host.calls.at(-1), { route: 'host/finish', payload: { jobId: 'job-12345678', ok: true } })
  // A picture workflow that hands back a clip, or a text to image job that arrives with a picture, does not go through.
  const wrong = client({ replies: { 'host/heartbeat': offer({}), 'host/claim': { ok: true } }, settings: { allowedWorkflows: ['h3-t2i'] }, run: async () => ({ mimeType: 'video/mp4', bytes: mp4(4000) }) })
  await wrong.made.beat(); await settle(wrong.made)
  assert.deepEqual(wrong.calls.at(-1), { route: 'host/finish', payload: { jobId: 'job-12345678', ok: false, error: 'host_failed' } })
  const extra = client({ replies: { 'host/heartbeat': offer({ image: { mimeType: 'image/png', bytes: 4000, pieces: 1 } }) }, settings: { allowedWorkflows: ['h3-t2i'] }, run: async () => { throw new Error('must not run') } })
  await extra.made.beat(); await settle(extra.made)
  assert.deepEqual(extra.calls.filter(call => call.route === 'host/claim').map(call => call.payload), [{ jobId: 'job-12345678', accept: false }])
  // Collecting: a real PNG is handed on with a .png name; bytes that are not one are refused.
  const picture = png(5000), done = { ok: true, status: 'done', output: { mimeType: 'image/png', bytes: 5000, pieces: 1 } }
  const back = await client({ replies: { 'job/status': done, 'job/output': { ok: true, data: picture.toString('base64') } } }).made.collect('job-12345678')
  assert.deepEqual([back.mimeType, back.filename, back.bytes.equals(picture)], ['image/png', 'velorn-network-job-123456.png', true])
  await assert.rejects(client({ replies: { 'job/status': done, 'job/output': { ok: true, data: mp4(5000).toString('base64') } } }).made.collect('job-12345678'), { code: 'GPU_NETWORK_INVALID' })
})

test('every route Velorn\'s own code calls is one the transport lets out', async () => {
  // "Report" on the owner's side was refused here, before anything was sent, and read as "could not be reached".
  const source = require('node:fs').readFileSync(require.resolve('../electron/gpuShareClient.cjs'), 'utf8')
  const routes = new Set([...source.matchAll(/\b(?:must|call)\('([a-z]+(?:\/[a-z]+)?)'/g)].map(match => match[1]))
  assert.ok(routes.has('host/report') && routes.has('host/heartbeat') && routes.size > 15)
  for (const route of routes) {
    // Port 9 answers nothing: a route that is let out fails as unreachable, a route that is not is rejected first.
    const outcome = await requestGpuNetwork({ url: new URL(`http://127.0.0.1:9/account/desktop/gpu/${route}`), token: 'a'.repeat(43), body: {}, allowLocalTest: true }).catch(error => error.code)
    assert.notEqual(outcome, 'GPU_NETWORK_REJECTED', route)
  }
})
