'use strict'
// This computer's two roles on the Velorn network.
//
// HOST (only while the person has switched sharing on): every few seconds tell
// the queue what this computer offers and whether it is free, and take the next
// job if there is one. A job is checked here before it is accepted: it must be
// a workflow the person allowed, its description must pass the content check,
// and, when the person asked for that, they approve it first. Then it runs
// through gpuShareHostRunner and the clip goes back in pieces. One job at a time.
//
// REQUESTER: list the hosts this account may use, send one job (description
// checked here first), follow it, collect the clip.
//
// The queue's replies are data. Nothing in them can change the person's sharing
// choices, name a file or path, or add a workflow.
const { getApproved, checkImage, IMAGE_TYPES } = require('./gpuShareWorkflows.cjs')
const { checkPrompt } = require('./gpuShareFilter.cjs')

const PIECE = 192 * 1024
const OUTPUT_MAX = 96 * 1024 * 1024
const VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm'])
// What a finished job may be: a clip, or the PNG picture a picture workflow makes.
const RESULT_EXTENSION = Object.freeze({ 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'image/png': 'png' })
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const wholeResult = (mimeType, data) => mimeType === 'image/png' ? data.subarray(0, 8).equals(PNG) : mimeType === 'video/webm' || data.toString('ascii', 4, 8) === 'ftyp'
const resultFits = (entry, mimeType) => entry.kind === 'image' ? mimeType === 'image/png' : VIDEO_TYPES.has(mimeType)
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fault = (code, message) => Object.assign(new Error(message), { code, publicMessage: message })
// What the queue's refusals mean, in the person's words.
const REFUSALS = Object.freeze({
  unauthorized: 'Sign in to your Velorn account on this computer first.', host_unavailable: 'That computer is not available right now.',
  workflow_unavailable: 'That computer does not offer this workflow right now.', daily_limit: 'You\'ve used today\'s free jobs. Check again later.',
  one_at_a_time: 'You already have a job on the Velorn network. Wait for it to finish.', host_busy: 'That computer has a queue. Try again in a while.',
  network_full: 'The Velorn network is full right now. Try again in a while.', banned: 'This account can no longer send jobs on the Velorn network.',
  unavailable: 'The Velorn network cannot take this job right now. Try again later.', too_large: 'That is too large to send.', not_found: 'That job is no longer on the Velorn network.' })
const refused = reply => fault(`GPU_NETWORK_${String(reply?.error || 'unavailable').toUpperCase()}`, REFUSALS[reply?.error] || 'The Velorn network could not do that right now.')
const pieceCount = bytes => Math.ceil(bytes / PIECE)

const OWN_ID = /^own-[a-f0-9]{16}$/
const OWN_SHAPES = Object.freeze({ 'text-to-picture': { kind: 'image', needsImage: false }, 'picture-edit': { kind: 'image', needsImage: true },
  'picture-to-video': { kind: 'video', needsImage: true }, 'text-to-video': { kind: 'video', needsImage: false } })
// What a sender may put in a job for someone's own workflow: a description and a seed. Nothing else exists to choose.
function ownChoices(input) {
  if (!plain(input)) throw fault('GPU_SHARE_INVALID', 'Missing choices for this job.')
  for (const key of Object.keys(input)) if (!['prompt', 'seed'].includes(key)) throw fault('GPU_SHARE_INVALID', `"${String(key).slice(0, 40)}" is not a choice this workflow takes.`)
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
  if (!prompt || prompt.length > 2000 || /\u0000/.test(prompt)) throw fault('GPU_SHARE_INVALID', 'Write a description of up to 2000 characters.')
  const seed = input.seed === undefined ? null : input.seed
  if (seed !== null && (!Number.isSafeInteger(seed) || seed < 0)) throw fault('GPU_SHARE_INVALID', 'The seed must be a whole number.')
  return { prompt, seed }
}

function createGpuShareClient({ host, runner, getNetwork, jobLog = null, confirmJob = async () => false, getComputerName = () => 'A Velorn computer', getOwn = () => null,
  onChange = () => {}, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (typeof host?.status !== 'function' || typeof host.getSettings !== 'function' || typeof host.idle !== 'function' || typeof runner?.run !== 'function' || typeof getNetwork !== 'function') throw new TypeError('The Velorn network client needs the sharing choices, the job runner and the service connection.')
  let hosting = { connected: false, note: 'Sharing is off.', job: null, lastError: null, lastJob: null, recent: [] }
  // The last few jobs other people sent here, so the person can look back at one and report it. With a job log
  // the picture and the clip are kept too, and the list is still there after Velorn restarts.
  const remember = (job, requester, outcome, files = {}) => { if (job.requester?.sameAccount) return
    const prompt = String(job.choices?.prompt || '').slice(0, 300), hasFiles = Boolean(jobLog && (files.image || files.clip))
    hosting = { ...hosting, recent: [{ jobId: job.jobId, from: requester, prompt, outcome, at: Date.now(), reported: false, hasFiles }, ...hosting.recent.filter(item => item.jobId !== job.jobId)].slice(0, 10) }
    jobLog?.save({ jobId: job.jobId, from: requester, prompt, outcome, image: files.image || null, clip: files.clip || null }).catch(() => {}) }
  if (jobLog) jobLog.list().then(items => { if (!hosting.recent.length && items.length) { hosting = { ...hosting, recent: items.slice(0, 10) }; tell() } }, () => {})
  let current = null, beating = false, offered = null
  const seenOwn = new Map() // hostId -> the own workflows that computer last listed, for checking a job before it is sent
  const tell = () => { try { onChange(hostState()) } catch { /* Display only. */ } }
  const hostState = () => ({ ...hosting, job: hosting.job ? { ...hosting.job } : null, recent: hosting.recent.map(item => ({ ...item })) })

  async function call(route, payload, options) {
    const network = getNetwork()
    if (typeof network?.request !== 'function') throw fault('GPU_NETWORK_SIGNED_OUT', 'Sign in to your Velorn account on this computer first.')
    return network.request(route, payload, options)
  }
  async function must(route, payload, options) {
    const reply = await call(route, payload, options)
    if (reply?.ok !== true) throw refused(reply)
    return reply
  }

  // ---------------- Host ----------------
  async function runOffered(job, settings) {
    const controller = new AbortController()
    const requester = job.requester?.sameAccount ? 'your own computer' : job.requester?.email || 'someone you invited'
    current = { jobId: job.jobId, controller }
    const files = { image: null, clip: null } // What arrived and what was made, for the person to look at afterwards.
    hosting = { ...hosting, job: { jobId: job.jobId, workflowId: job.workflowId, from: requester, status: 'checking' } }; tell()
    const decline = async reason => { try { await call('host/claim', { jobId: job.jobId, accept: false }) } catch { /* It expires on the service by itself. */ }
      hosting = { ...hosting, job: null, lastJob: { from: requester, outcome: 'declined', reason, at: Date.now() } }; remember(job, requester, 'declined'); current = null; tell() }
    try {
      // 1. Is this still something this person allows and this computer was asked properly?
      // One of Velorn's own that the person ticked, or one of the person's own that they chose to share.
      let entry = getApproved(job.workflowId)
      if (entry && !settings.allowedWorkflows.includes(job.workflowId)) entry = null
      if (!entry && OWN_ID.test(job.workflowId || '')) { try { entry = (await getOwn()?.resolveShared(job.workflowId))?.entry || null } catch { entry = null } }
      if (!entry) return await decline('That workflow is not allowed here.')
      let choices
      try { choices = entry.normalize(job.choices) } catch { return await decline('The job was not in the form this workflow takes.') }
      const verdict = checkPrompt(choices.prompt)
      if (!verdict.ok) return await decline(verdict.reason)
      // A workflow that starts from a picture must come with one; one that does not must come without.
      if (entry.needsImage ? !plain(job.image) || !Object.hasOwn(IMAGE_TYPES, job.image.mimeType) || !Number.isInteger(job.image.bytes) || job.image.bytes < 16 || job.image.bytes > 10 * 1024 * 1024
        || job.image.pieces !== pieceCount(job.image.bytes) : job.image != null) return await decline('The job\'s picture was not acceptable.')
      // 2. The person's own say, when they asked for it. Their own computers are not asked about.
      if (settings.askBeforeEach && !job.requester?.sameAccount) {
        hosting = { ...hosting, job: { ...hosting.job, status: 'asking' } }; tell()
        const yes = await confirmJob({ from: requester, workflowName: entry.name, prompt: choices.prompt, seconds: choices.seconds, size: choices.size, shape: choices.shape })
        if (yes !== true) return await decline('You did not approve it.')
      }
      const claimed = await call('host/claim', { jobId: job.jobId, accept: true })
      if (claimed?.ok !== true) { hosting = { ...hosting, job: null }; current = null; tell(); return }
      // 3. Fetch the picture, run, send the clip back.
      hosting = { ...hosting, job: { ...hosting.job, status: 'preparing' } }; tell()
      let image = null
      if (entry.needsImage) {
        const parts = []
        for (let index = 0; index < job.image.pieces; index++) {
          const piece = await must('host/input', { jobId: job.jobId, index }, { signal: controller.signal })
          parts.push(Buffer.from(String(piece.data || ''), 'base64'))
        }
        image = { mimeType: job.image.mimeType, bytes: Buffer.concat(parts) }
        if (image.bytes.length !== job.image.bytes) throw fault('GPU_SHARE_INVALID', 'The picture did not arrive whole.')
        checkImage(image); files.image = image
      }
      const result = await runner.run({ jobId: job.jobId, workflowId: job.workflowId, choices, image, signal: controller.signal,
        onStatus: ({ status }) => {
          hosting = { ...hosting, job: hosting.job ? { ...hosting.job, status } : null }; tell()
          // The queue answers each progress note with whether the requester cancelled.
          call('host/progress', { jobId: job.jobId, status }).then(reply => { if (reply?.cancelRequested) controller.abort() }, () => {})
        } })
      if (!resultFits(entry, result.mimeType) || !Buffer.isBuffer(result.bytes) || result.bytes.length < 16 || result.bytes.length > OUTPUT_MAX) throw fault('GPU_SHARE_COMFY_FAILED', 'The finished result was not something that can be sent.')
      files.clip = { mimeType: result.mimeType, bytes: result.bytes }
      hosting = { ...hosting, job: { ...hosting.job, status: 'sending' } }; tell()
      const total = pieceCount(result.bytes.length)
      for (let index = 0; index < total; index++) {
        const body = { jobId: job.jobId, index, data: result.bytes.subarray(index * PIECE, (index + 1) * PIECE).toString('base64'),
          ...(index === 0 ? { file: { mimeType: result.mimeType, bytes: result.bytes.length, pieces: total } } : {}) }
        let reply
        try { reply = await call('host/output', body, { signal: controller.signal }) }
        catch (error) { if (controller.signal.aborted) throw error; reply = await call('host/output', body, { signal: controller.signal }) } // The queue accepts a repeated piece.
        if (reply?.ok !== true) throw refused(reply)
      }
      await must('host/finish', { jobId: job.jobId, ok: true })
      hosting = { ...hosting, job: null, lastJob: { from: requester, outcome: 'done', at: Date.now() } }; remember(job, requester, 'done', files)
    } catch (error) {
      const code = error?.code === 'GPU_SHARE_STOPPED' || controller.signal.aborted ? 'stopped'
        : error?.code === 'GPU_SHARE_MODELS_MISSING' ? 'models_missing' : error?.code === 'GPU_SHARE_NOT_LOCAL' ? 'not_runnable'
        : error?.code === 'GPU_SHARE_TIMEOUT' ? 'took_too_long' : 'host_failed'
      try { await call('host/finish', { jobId: job.jobId, ok: false, error: code }) } catch { /* The queue gives up on it by itself. */ }
      hosting = { ...hosting, job: null, lastJob: { from: requester, outcome: code === 'stopped' ? 'stopped' : 'failed', reason: error?.publicMessage || 'The job could not be finished.', at: Date.now() } }; remember(job, requester, code === 'stopped' ? 'stopped' : 'failed', files)
    } finally { current = null; tell() }
  }

  // One heartbeat. Safe to call on a timer: overlapping calls are skipped.
  async function beat() {
    if (beating) return hostState()
    beating = true
    try {
      // Nothing is asked of ComfyUI or the network while sharing is off.
      const settings = await host.getSettings()
      if (!settings.enabled) {
        if (current) current.controller.abort() // Switched off mid-job: stop it.
        offered = null
        if (hosting.connected || hosting.note !== 'Sharing is off.') { hosting = { ...hosting, connected: false, note: 'Sharing is off.' }; tell() }
        return hostState()
      }
      // What this computer can run changes rarely and is a heavy question for
      // ComfyUI, so it is asked again only now and then or when the choices change.
      const key = JSON.stringify(settings.allowedWorkflows)
      if (current && offered) { /* Busy with a job: keep what was offered. */ }
      else if (!offered || offered.key !== key || now() - offered.at > 60000 || !offered.list.length) { const state = await host.status(); offered = { key, at: now(), list: state.offering, own: Array.isArray(state.ownOffering) ? state.ownOffering : [] } }
      const free = current ? { idle: false, reasons: [] } : await host.idle()
      const status = { offering: offered.list, idle: free.idle, reasons: free.reasons }
      // The own-workflow fields are sent only when there is one to offer, so nothing changes for a computer that shares none.
      // An own workflow carries its fingerprint only when its owner asked for it to be open to everyone.
      const own = (offered.own || []).filter(item => status.offering.includes(item.id)).slice(0, 12).map(item => ({ id: item.id, name: item.name, shape: item.shape, ...(item.fingerprint ? { fingerprint: item.fingerprint } : {}) }))
      const reply = await call('host/heartbeat', { offering: status.offering, idle: status.idle && !current, invited: settings.invited,
        dailyLimitPerPerson: settings.dailyLimitPerPerson, askBeforeEach: settings.askBeforeEach, name: String(getComputerName() || 'A Velorn computer').slice(0, 80),
        ...(own.length ? { own, ...(settings.displayName ? { maker: settings.displayName } : {}) } : {}),
        // Open to everyone is the owner's own switch; the field is sent only when it is on.
        ...(settings.everyone?.enabled ? { everyone: { perPerson: settings.everyone.perPerson, total: settings.everyone.total } } : {}) })
      if (reply?.ok !== true) { hosting = { ...hosting, connected: false, note: REFUSALS[reply?.error] || 'The Velorn network is not reachable right now.' }; tell(); return hostState() }
      hosting = { ...hosting, connected: true, lastError: null,
        note: !status.offering.length ? 'Sharing is on, but nothing is being offered. Allow a workflow this computer can run.' : status.idle || current ? 'Sharing is on.' : `Sharing is on, but this computer is not free. ${status.reasons.join(' ')}` }
      if (current && Array.isArray(reply.cancelled) && reply.cancelled.includes(current.jobId)) current.controller.abort()
      tell()
      // Take a job only when free. It runs apart from the heartbeat, which keeps going.
      if (!current && plain(reply.job) && typeof reply.job.jobId === 'string') void runOffered(reply.job, settings)
    } catch (error) {
      hosting = { ...hosting, connected: false, note: error?.publicMessage || 'The Velorn network is not reachable right now.' }; tell()
    } finally { beating = false }
    return hostState()
  }

  // Tells the service that a job someone else sent here was sexually explicit. The service keeps who sent it.
  async function report(jobId) {
    const found = hosting.recent.find(item => item.jobId === jobId)
    if (!found) throw fault('GPU_SHARE_INVALID', 'That job is no longer in the list.')
    await must('host/report', { jobId, reason: 'explicit' })
    // The result goes along, so a reviewer judges what was really made and not only the words. It does not hold up the report.
    evidenceTail = evidenceTail.then(() => sendEvidence(jobId)).catch(() => {})
    hosting = { ...hosting, recent: hosting.recent.map(item => item.jobId === jobId ? { ...item, reported: true } : item) }; tell()
    jobLog?.markReported(jobId).catch(() => {})
    return { reported: true }
  }

  // Sends the files this computer kept of a reported job. The service takes them only if they match the
  // fingerprints it wrote down when the job ran, so nothing else can be handed in.
  let evidenceTail = Promise.resolve()
  async function sendEvidence(jobId) {
    if (typeof jobLog?.files !== 'function') return
    const kept = await jobLog.files(jobId)
    for (const [kind, file] of [['output', kept.clip], ['image', kept.image]]) {
      if (!file?.bytes?.length) continue
      const total = pieceCount(file.bytes.length)
      try {
        for (let index = 0; index < total; index++) {
          const body = { jobId, kind, index, data: Buffer.from(file.bytes.subarray(index * PIECE, (index + 1) * PIECE)).toString('base64'),
            ...(index === 0 ? { file: { mimeType: file.mimeType, bytes: file.bytes.length, pieces: total } } : {}) }
          let reply
          try { reply = await call('host/evidence', body) } catch { reply = await call('host/evidence', body) } // A repeated piece is accepted.
          if (reply?.ok !== true) break
        }
      } catch { /* The report itself stands; the reviewer sees that nothing came with it. */ }
    }
  }

  // ---------------- Requester ----------------
  async function listHosts() {
    const reply = await must('hosts', {})
    const text = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
    const hosts = (Array.isArray(reply.hosts) ? reply.hosts : []).filter(item => plain(item) && /^[a-f0-9]{32}$/.test(item.hostId || '')).slice(0, 50).map(item => {
      const offering = Array.isArray(item.workflows) ? item.workflows : []
      // An owner's own workflows: the queue's words are data, so each is checked and cut to size here.
      const own = (Array.isArray(item.own) ? item.own : []).filter(entry => plain(entry) && OWN_ID.test(entry.id || '') && offering.includes(entry.id) && Object.hasOwn(OWN_SHAPES, entry.shape) && text(entry.name, 60))
        .slice(0, 12).map(entry => ({ id: entry.id, name: text(entry.name, 60), shape: entry.shape, ...OWN_SHAPES[entry.shape] }))
      return { hostId: item.hostId, name: String(item.name || 'A Velorn computer').slice(0, 80), idle: item.idle === true, sameAccount: item.sameAccount === true,
        askBeforeEach: item.askBeforeEach === true, waiting: Number.isInteger(item.waiting) ? item.waiting : 0, ...(item.everyone === true ? { everyone: true } : {}),
        workflows: offering.filter(id => getApproved(id)), ...(own.length ? { own, maker: text(item.maker, 40) || 'A Velorn creator' } : {}),
        ...(Number.isInteger(item.remainingToday) ? { remainingToday: item.remainingToday } : {}) }
    }).filter(item => item.workflows.length || item.own)
    seenOwn.clear(); for (const item of hosts) if (item.own) seenOwn.set(item.hostId, item.own)
    return { hosts, emailVerified: reply.emailVerified === true, banned: reply.banned === true }
  }
  // Sends one job and resolves once the picture is fully delivered to the queue.
  async function submit({ hostId, workflowId, choices, image } = {}) {
    // Velorn's own list, or a workflow that computer's owner listed as their own the last time this account looked.
    const listed = getApproved(workflowId) ? null : (seenOwn.get(hostId) || []).find(item => item.id === workflowId)
    const entry = getApproved(workflowId) || (listed ? { needsImage: listed.needsImage, normalize: ownChoices } : null)
    if (!entry) throw fault('GPU_SHARE_WORKFLOW_UNKNOWN', 'That workflow is not offered on the Velorn network.')
    const checked = entry.normalize(choices)
    const verdict = checkPrompt(checked.prompt)
    if (!verdict.ok) throw fault(verdict.code, verdict.reason)
    if (entry.needsImage) checkImage(image)
    else if (image != null) throw fault('GPU_SHARE_INVALID', 'This workflow does not take a picture.')
    if (typeof hostId !== 'string' || !/^[a-f0-9]{32}$/.test(hostId)) throw fault('GPU_SHARE_INVALID', 'Choose a computer on the Velorn network.')
    const { seed, ...sent } = checked
    const made = await must('submit', { hostId, workflowId, choices: seed === null ? sent : { ...sent, seed },
      ...(entry.needsImage ? { image: { mimeType: image.mimeType, bytes: image.bytes.length, pieces: pieceCount(image.bytes.length) } } : {}) })
    const total = entry.needsImage ? pieceCount(image.bytes.length) : 0
    try {
      for (let index = 0; index < total; index++) {
        const body = { jobId: made.jobId, index, data: image.bytes.subarray(index * PIECE, (index + 1) * PIECE).toString('base64') }
        let reply
        try { reply = await call('job/input', body) } catch { reply = await call('job/input', body) }
        if (reply?.ok !== true) throw refused(reply)
      }
    } catch (error) { try { await call('job/cancel', { jobId: made.jobId }); await call('job/done', { jobId: made.jobId }) } catch { /* It expires by itself. */ } throw error }
    return { jobId: made.jobId }
  }
  const JOB_ERRORS = Object.freeze({ declined: 'The other computer did not accept this job.', host_unavailable: 'The other computer went away before the job was done.',
    cancelled: 'You cancelled this job.', stopped: 'The job was stopped.', models_missing: 'The other computer does not have the models for this any more.',
    not_runnable: 'The other computer could not run this workflow.', took_too_long: 'The job took too long and was stopped.', incomplete_result: 'The clip did not arrive whole.', host_failed: 'The other computer could not finish the job.' })
  async function jobStatus(jobId) {
    const reply = await must('job/status', { jobId })
    return { jobId, status: reply.status, ...(reply.progress ? { progress: reply.progress } : {}), hostOnline: reply.hostOnline === true,
      ...(reply.error ? { error: JOB_ERRORS[reply.error] || 'The job could not be finished.' } : {}),
      ...(reply.status === 'done' && plain(reply.output) ? { output: { mimeType: reply.output.mimeType, bytes: reply.output.bytes, pieces: reply.output.pieces } } : {}) }
  }
  // Fetches the finished clip, then tells the queue to forget the job (unless
  // the caller keeps it until the clip is safely saved).
  async function collect(jobId, { keep = false } = {}) {
    const state = await jobStatus(jobId)
    if (state.status !== 'done' || !state.output) throw fault('GPU_NETWORK_NOT_READY', 'The clip is not ready yet.')
    const { mimeType, bytes, pieces } = state.output
    if (!Object.hasOwn(RESULT_EXTENSION, mimeType) || !Number.isInteger(bytes) || bytes < 16 || bytes > OUTPUT_MAX || pieces !== pieceCount(bytes)) throw fault('GPU_NETWORK_INVALID', 'The clip that came back was not acceptable.')
    const parts = []
    for (let index = 0; index < pieces; index++) {
      let reply
      try { reply = await must('job/output', { jobId, index }) } catch (error) { if (error?.code?.startsWith('GPU_NETWORK_NOT')) throw error; reply = await must('job/output', { jobId, index }) }
      parts.push(Buffer.from(String(reply.data || ''), 'base64'))
    }
    const data = Buffer.concat(parts)
    if (data.length !== bytes || !wholeResult(mimeType, data)) throw fault('GPU_NETWORK_INVALID', mimeType === 'image/png' ? 'The picture that came back was not a picture.' : 'The clip that came back was not a video.')
    if (!keep) { try { await call('job/done', { jobId }) } catch { /* It is forgotten after a while anyway. */ } }
    const extension = RESULT_EXTENSION[mimeType]
    return { bytes: data, mimeType, filename: `velorn-network-${jobId.slice(0, 10)}.${extension}` }
  }
  async function cancel(jobId) { const reply = await must('job/cancel', { jobId }); return { status: reply.status, cancelRequested: reply.cancelRequested === true } }
  async function forget(jobId) { try { await call('job/done', { jobId }) } catch { /* Nothing to do. */ } }

  // The loop that keeps the host's heartbeat going. Returns a function that stops it.
  function start(intervalMs = 5000) {
    let stopped = false
    ;(async () => { while (!stopped) { await beat().catch(() => {}); await sleep(intervalMs) } })()
    return () => { stopped = true; if (current) current.controller.abort() }
  }

  // ---------------- Open to everyone: review ----------------
  const SID = /^[a-f0-9]{24}$/
  const line = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
  const sentAlong = value => plain(value) && typeof value.mimeType === 'string' && /^(?:image|video)\/[a-z0-9.+-]{2,20}$/.test(value.mimeType) && Number.isInteger(value.bytes) && value.bytes > 0 ? { mimeType: value.mimeType, bytes: value.bytes } : null
  // The owner's side: ask for a review of one own workflow, take it back, see where each stands.
  async function ownSubmit(sent) { const reply = await must('own/submit', sent); return { status: reply.submission?.status || 'pending' } }
  async function ownWithdraw(id) { await must('own/withdraw', { id }); return { withdrawn: true } }
  async function ownStatus() {
    const reply = await must('own/status', {})
    return { reviewer: reply.reviewer === true, submissions: (Array.isArray(reply.submissions) ? reply.submissions : []).filter(item => plain(item) && OWN_ID.test(item.ownId || '') && /^[a-f0-9]{64}$/.test(item.fingerprint || '')
      && ['pending', 'approved', 'declined', 'paused'].includes(item.status)).slice(0, 24).map(item => ({ ownId: item.ownId, fingerprint: item.fingerprint, status: item.status, note: line(item.note, 300) })) }
  }
  // Someone who ran a creator's workflow says it is not what it claims.
  async function reportWorkflow({ hostId, workflowId } = {}) {
    if (!/^[a-f0-9]{32}$/.test(hostId || '') || !OWN_ID.test(workflowId || '')) throw fault('GPU_SHARE_INVALID', 'That workflow cannot be reported.')
    await must('workflow/report', { hostId, workflowId }); return { reported: true }
  }
  // The reviewer's side. The service answers "not found" to anyone who is not a reviewer.
  async function reviewList() {
    const reply = await must('review/list', {})
    return { items: (Array.isArray(reply.items) ? reply.items : []).filter(item => plain(item) && SID.test(item.sid || '') && Object.hasOwn(OWN_SHAPES, item.shape)).slice(0, 300).map(item => ({
      sid: item.sid, name: line(item.name, 60), shape: item.shape, maker: line(item.maker, 40), email: line(item.email, 260), status: ['pending', 'approved', 'declined', 'paused'].includes(item.status) ? item.status : 'pending',
      note: line(item.note, 300), hasExample: item.hasExample === true, hasGraph: item.hasGraph === true, needsImage: OWN_SHAPES[item.shape].needsImage, kind: OWN_SHAPES[item.shape].kind, reports: Number.isInteger(item.reports) ? item.reports : 0, submittedAt: Number.isFinite(item.submittedAt) ? item.submittedAt : 0,
      models: (Array.isArray(item.models) ? item.models : []).slice(0, 40).map(value => line(value, 160)), parts: (Array.isArray(item.parts) ? item.parts : []).slice(0, 160).map(value => line(value, 160)) })),
      reports: (Array.isArray(reply.reports) ? reply.reports : []).filter(item => plain(item) && typeof item.jobId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(item.jobId)).slice(0, 100).map(item => ({
        jobId: item.jobId, email: line(item.email, 260), prompt: line(item.prompt, 300), reason: line(item.reason, 40), at: Number.isFinite(item.at) ? item.at : 0,
        // Who reported it, how their reports ended so far, and what their computer sent along.
        reporter: line(item.reporter, 260), reporterReports: Number.isInteger(item.reporterReports) ? item.reporterReports : 0, reporterDismissed: Number.isInteger(item.reporterDismissed) ? item.reporterDismissed : 0,
        result: sentAlong(item.result), picture: sentAlong(item.picture),
        // The internet address the job came from, and other accounts seen on it. Only reviewers are sent these.
        address: typeof item.address === 'string' && /^[0-9a-fA-F.:]{3,45}$/.test(item.address) ? item.address : '',
        others: (Array.isArray(item.others) ? item.others : []).slice(0, 5).map(other => line(other, 260)).filter(Boolean) })) }
  }
  async function reviewExample(sid) {
    if (!SID.test(sid || '')) throw fault('GPU_SHARE_INVALID', 'There is no example for that.')
    const reply = await must('review/example', { sid })
    const bytes = Buffer.from(String(reply.data || ''), 'base64')
    if (bytes.length < 4 || bytes.length > 200 * 1024 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw fault('GPU_NETWORK_INVALID', 'The example that came back was not a picture.')
    return { mimeType: 'image/jpeg', bytes: new Uint8Array(bytes) }
  }
  async function ownGraph({ id, fingerprint, graph } = {}) { await must('own/graph', { id, fingerprint, graph }); return { sent: true } }
  // The copy of a submitted workflow, with whether it really is the version the review is for.
  async function reviewGraph(sid) {
    if (!SID.test(sid || '')) throw fault('GPU_SHARE_INVALID', 'There is no workflow to open for that.')
    const reply = await must('review/graph', { sid })
    const { validateApiWorkflow, stableWorkflowJson } = await import('./workflowApiGraph.mjs')
    let workflow
    try { workflow = validateApiWorkflow(JSON.parse(String(reply.graph || ''))) } catch { throw fault('GPU_NETWORK_INVALID', 'The workflow that came back could not be read safely.') }
    const print = require('node:crypto').createHash('sha256').update(stableWorkflowJson(workflow)).digest('hex')
    return { workflow, matches: print === reply.fingerprint }
  }
  // One test job through a submitted workflow, on its owner's computer. Resolves with what it made.
  async function reviewTry({ sid, prompt, image = null } = {}) {
    if (!SID.test(sid || '')) throw fault('GPU_SHARE_INVALID', 'Choose a workflow to try.')
    const choices = ownChoices({ prompt })
    const verdict = checkPrompt(choices.prompt)
    if (!verdict.ok) throw fault(verdict.code, verdict.reason)
    if (image) checkImage(image)
    const made = await must('review/try', { sid, choices: { prompt: choices.prompt }, ...(image ? { image: { mimeType: image.mimeType, bytes: image.bytes.length, pieces: pieceCount(image.bytes.length) } } : {}) })
    try {
      for (let index = 0; image && index < pieceCount(image.bytes.length); index++) {
        const reply = await call('job/input', { jobId: made.jobId, index, data: image.bytes.subarray(index * PIECE, (index + 1) * PIECE).toString('base64') })
        if (reply?.ok !== true) throw refused(reply)
      }
      const started = now()
      for (;;) {
        const state = await jobStatus(made.jobId)
        if (state.status === 'done') break
        if (state.status === 'failed' || state.status === 'cancelled') throw fault('GPU_NETWORK_TRY_FAILED', state.error || 'The test did not finish.')
        if (now() - started > 20 * 60 * 1000) throw fault('GPU_NETWORK_TRY_FAILED', 'The test took too long.')
        await sleep(3000)
      }
      const result = await collect(made.jobId)
      return { mimeType: result.mimeType, bytes: new Uint8Array(result.bytes) }
    } catch (error) { try { await call('job/cancel', { jobId: made.jobId }); await call('job/done', { jobId: made.jobId }) } catch { /* It expires by itself. */ } throw error }
  }
  async function reviewDecide({ sid, approve, note } = {}) {
    if (!SID.test(sid || '') || typeof approve !== 'boolean') throw fault('GPU_SHARE_INVALID', 'Choose to approve or decline.')
    await must('review/decide', { sid, approve, ...(typeof note === 'string' && note.trim() ? { note: note.trim().slice(0, 300) } : {}) }); return { decided: true }
  }
  async function reviewBan({ sid, jobId, reporter } = {}) {
    const target = SID.test(sid || '') ? { sid } : typeof jobId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(jobId) ? { jobId, ...(reporter === true ? { reporter: true } : {}) } : null
    if (!target) throw fault('GPU_SHARE_INVALID', 'Choose who to stop.')
    const reply = await must('review/ban', target); return { banned: reply.banned === true }
  }
  // What the reporting owner's computer sent along: 'output' is what the job made, 'image' the picture it started from.
  async function reviewEvidence({ jobId, kind } = {}) {
    if (typeof jobId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(jobId) || !['output', 'image'].includes(kind)) throw fault('GPU_SHARE_INVALID', 'Choose a reported job.')
    const first = await must('review/evidence', { jobId, kind, index: 0 })
    const { mimeType, bytes, pieces } = plain(first.file) ? first.file : {}
    const allowed = kind === 'output' ? Object.hasOwn(RESULT_EXTENSION, mimeType) : ['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)
    if (!allowed || !Number.isInteger(bytes) || bytes < 16 || bytes > OUTPUT_MAX || pieces !== pieceCount(bytes)) throw fault('GPU_NETWORK_INVALID', 'What came back was not acceptable.')
    const parts = [Buffer.from(String(first.data || ''), 'base64')]
    for (let index = 1; index < pieces; index++) parts.push(Buffer.from(String((await must('review/evidence', { jobId, kind, index })).data || ''), 'base64'))
    const data = Buffer.concat(parts)
    if (data.length !== bytes || (kind === 'output' && !wholeResult(mimeType, data))) throw fault('GPU_NETWORK_INVALID', 'What came back was not a picture or a video.')
    return { mimeType, bytes: new Uint8Array(data) }
  }
  // Sets a reported job aside: it leaves the review list and nobody is stopped.
  async function reviewDismiss({ jobId } = {}) {
    if (typeof jobId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(jobId)) throw fault('GPU_SHARE_INVALID', 'Choose a reported job.')
    await must('review/dismiss', { jobId }); return { dismissed: true }
  }

  // The person changed what they offer: tell the queue on the next beat rather than a minute later.
  function refresh() { offered = null; return beat() }

  return { beat, refresh, start, hostState, report, listHosts, submit, jobStatus, collect, cancel, forget,
    ownSubmit, ownGraph, ownWithdraw, ownStatus, reportWorkflow, reviewList, reviewExample, reviewGraph, reviewTry, reviewDecide, reviewBan, reviewDismiss, reviewEvidence, evidenceSettled: () => evidenceTail }
}

module.exports = { createGpuShareClient, PIECE }
