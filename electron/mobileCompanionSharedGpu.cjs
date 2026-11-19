'use strict'
// GPU sharing for the person's paired phone. The phone is a remote control:
// it picks one of the creators' workflows this account may use, writes a
// description (and adds a photo where the workflow starts from one), and this
// computer sends the job to the Velorn network exactly as its own GPU sharing
// tab would. Nothing here costs anything: there is no price and no approval.
//
// What the phone can do: read the creators' workflows, send ONE job at a time,
// watch it, stop it, and fetch the finished picture or clip.
//
// What it cannot do: name a computer, a workflow or a file that this computer
// did not just list; change anything but the description; skip the rules shown
// before a job goes to someone else's computer; or reach the service itself.
// The description check, the daily limits, the records and the bans are the
// same ones every job from this computer goes through (gpuShareClient.cjs).
//
// The main window follows the job too and saves the result into the open
// project (velornNetworkJob.mjs). This module only keeps what the phone is shown.
//
// "Yours": the workflows this computer's owner added and tested here also show
// on the phone, and run on this computer itself. Nothing leaves it, so there is
// no rules step, no description check and no daily limit: it is the person's
// own ComfyUI, as if they had pressed Run at the desk. One at a time.
const fs = require('node:fs/promises')
const path = require('node:path')
const { randomBytes } = require('node:crypto')

const LIMITS = Object.freeze({ entries: 8, cacheFiles: 8, promptChars: 2000 })
const CARD = /^[a-f0-9]{32}\.own-[a-f0-9]{16}$/, LOCAL_CARD = /^local\.(own-[a-f0-9]{16})$/
const JOB_ID = /^[A-Za-z0-9_-]{8,64}$/
const EXTENSION = { 'image/png': 'png', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value, required, optional = []) => object(value) && required.every(key => Object.hasOwn(value, key))
  && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
const refuse = (code, error) => ({ success: false, code, error })
const invalid = () => refuse('SHARED_INVALID', 'That request could not be read. Reload the page and try again.')
const failed = (error, fallback) => refuse(typeof error?.code === 'string' ? error.code.slice(0, 64) : 'SHARED_FAILED', typeof error?.publicMessage === 'string' && error.publicMessage ? error.publicMessage.slice(0, 600) : fallback)
const text = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
// Where a job stands, in the words the phone shows.
const STAGE = { uploading: 'Sending it…', waiting: 'Waiting for that computer to pick it up…', offered: 'Waiting for its owner to say yes…',
  preparing: 'Getting ready on that computer…', queued: 'Waiting its turn on that computer…', running: 'Being made…', collecting: 'Almost done…' }
const LOCAL_STAGE = { preparing: 'Getting ready on your computer…', queued: 'Waiting its turn on your computer…', running: 'Being made on your computer…', collecting: 'Almost done…' }

// `local` is this computer's own added workflows: { list: async () => [{ id, name, shape, kind, needsImage }], run: async ({ jobId, id, prompt, image, signal, onStatus }) => ({ mimeType, bytes }) }.
// `onLocalResult()` is called when one finished, so the window can save it into the project.
function createPhoneSharedGpu({ jobs, cacheDir, now = Date.now, local = null, onLocalResult = () => {} } = {}) {
  if (typeof jobs?.hosts !== 'function' || typeof jobs.send !== 'function' || typeof jobs.on !== 'function' || !path.isAbsolute(cacheDir || '')) throw new TypeError('GPU sharing for the phone needs the network jobs and a private cache folder.')
  // What the last look at the network offered: only these can be sent.
  const offered = new Map()
  // The phone's own jobs, newest last: jobId -> { jobId, label, kind, maker, createdAt, status, text, error, mediaId, file, saved }.
  const entries = new Map()
  const media = new Map() // mediaId -> jobId
  const mine = new Map() // what this computer itself offers: workflow id -> { id, name, kind, needsImage }
  let running = null // the one job being made on this computer: { jobId, controller }
  let swept = null

  const sweep = () => swept || (swept = fs.readdir(cacheDir).then(names => Promise.all(names
    .filter(name => /^shared-[A-Za-z0-9_-]{8,64}\.(?:png|mp4|mov|webm)(?:\.[a-f0-9]{12}\.part)?$/.test(name))
    .map(name => fs.unlink(path.join(cacheDir, name)).catch(() => {}))), () => {}))
  async function drop(entry) { if (entry.mediaId) media.delete(entry.mediaId); if (entry.file) await fs.unlink(entry.file.path).catch(() => {}) }
  async function trim() { while (entries.size > LIMITS.entries) { const [id, old] = entries.entries().next().value; entries.delete(id); await drop(old) } }
  // Keeps the finished picture or clip for the phone, once.
  async function keep(entry, clip) {
    if (entry.file || entry.keeping || !Object.hasOwn(EXTENSION, clip?.mimeType) || !(clip.bytes instanceof Uint8Array) || !clip.bytes.length) return
    entry.keeping = true
    try {
      await sweep()
      await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 })
      const extension = EXTENSION[clip.mimeType], target = path.join(cacheDir, `shared-${entry.jobId}.${extension}`), temporary = `${target}.${randomBytes(6).toString('hex')}.part`
      await fs.writeFile(temporary, clip.bytes, { mode: 0o600, flag: 'wx' })
      await fs.rename(temporary, target)
      entry.file = { path: target, mime: clip.mimeType, size: clip.bytes.length, name: `velorn-shared-${entry.jobId.slice(0, 8)}.${extension}` }
      entry.mediaId = randomBytes(24).toString('hex'); media.set(entry.mediaId, entry.jobId)
    } catch { /* Tried again the next time the phone asks. */ }
    finally { entry.keeping = false }
  }
  // What the main window and this module learn about the job, whoever asked.
  jobs.on(event => {
    const job = event?.job
    if (!job?.fromPhone || !JOB_ID.test(job.jobId || '')) return
    let entry = entries.get(job.jobId)
    if (!entry) {
      // Also a job from before Velorn was restarted: it is picked up from the job on record.
      entry = { jobId: job.jobId, label: text(job.label, 120) || 'A shared workflow', kind: job.kind === 'video' ? 'video' : 'image', maker: text(job.hostName, 80), createdAt: Number.isFinite(job.sentAt) ? job.sentAt : now(), status: 'waiting', text: STAGE.waiting, error: '', mediaId: '', file: null, saved: false }
      entries.set(job.jobId, entry); void trim()
    }
    if (event.type === 'state') {
      const status = event.state?.status
      if (status === 'done') { entry.status = 'done'; entry.text = 'Done' }
      else if (status === 'failed' || status === 'cancelled') { entry.status = status; entry.error = text(event.state.error, 300) || (status === 'cancelled' ? 'Stopped.' : 'The job did not finish.') }
      else { entry.status = status === 'running' ? 'running' : 'waiting'; entry.text = (status === 'running' && STAGE[event.state?.progress]) || STAGE[status] || 'Working on it…' }
      entry.hostOnline = event.state?.hostOnline !== false
    } else if (event.type === 'collected') { entry.status = 'done'; entry.text = 'Done'; void keep(entry, event.clip) }
    // The window forgets a finished job only once it is safely in the project.
    else if (event.type === 'forgotten') { if (entry.status === 'done') entry.saved = true; else if (!['failed', 'cancelled'].includes(entry.status)) { entry.status = 'failed'; entry.error = 'It was cleared on the computer before it finished.' } }
    else if (event.type === 'lost') { if (entry.status !== 'done') { entry.status = 'failed'; entry.error = 'That job is no longer on the Velorn network. Nothing was saved.' } }
  })

  const shown = entry => ({ jobId: entry.jobId, label: entry.label, kind: entry.kind, maker: entry.maker, ...(entry.local ? { local: true } : {}), createdAt: entry.createdAt, status: entry.status,
    ...(entry.status === 'failed' || entry.status === 'cancelled' ? { errorMessage: entry.error } : { text: entry.text }),
    ...(entry.status === 'waiting' || entry.status === 'running' ? { hostOnline: entry.hostOnline !== false } : {}),
    savedToProject: entry.saved === true, ready: Boolean(entry.file),
    ...(entry.file ? { url: `/media/create/${entry.mediaId}`, downloadUrl: `/media/create/${entry.mediaId}/download` } : {}) })

  // This computer's own workflows, as cards. They run here, so they are ready whenever nothing of the phone's is running here.
  async function yours() {
    mine.clear()
    if (!local) return []
    let list = []
    try { list = await local.list() } catch { list = [] }
    const cards = []
    for (const item of Array.isArray(list) ? list : []) {
      if (!/^own-[a-f0-9]{16}$/.test(item?.id || '')) continue
      // The phone page shows pictures and clips only. Music workflows are used on the computer for now.
      if (item.kind === 'audio' || item.shape === 'text-to-music') continue
      const entry = { id: item.id, name: text(item.name, 60) || 'A workflow', kind: item.kind === 'video' ? 'video' : 'image', needsImage: item.needsImage === true }
      mine.set(item.id, entry)
      cards.push({ cardId: `local.${item.id}`, name: entry.name, kind: entry.kind, needsImage: entry.needsImage, shape: item.shape, maker: 'Yours', makerId: 'local', local: true, yours: true, ready: !running, waiting: 0 })
    }
    return cards.slice(0, 24)
  }
  // Runs one of this computer's own workflows here, for the phone.
  function sendLocal(input, takePhoto) {
    const item = mine.get(LOCAL_CARD.exec(input.cardId)[1])
    if (!item) return refuse('SHARED_UNAVAILABLE', 'That workflow is not on this computer any more. Look at the list again.')
    if (running) return refuse('GPU_NETWORK_ONE_AT_A_TIME', 'Your computer is already making one. Wait for it to finish.')
    let image = null
    if (item.needsImage) {
      const photo = input.photoId === undefined ? null : takePhoto(input.photoId)
      if (!photo) return refuse('CREATE_PHOTO_MISSING', input.photoId === undefined ? `${item.name} starts from a picture. Add a photo first.` : 'The photo is no longer held on the computer. Add it again.')
      image = { mimeType: photo.mimeType, bytes: Buffer.from(photo.data) }
    }
    const jobId = `local-${randomBytes(12).toString('hex')}`, controller = new AbortController(), prompt = input.prompt.trim()
    const entry = { jobId, label: item.name, kind: item.kind, maker: '', local: true, prompt, createdAt: now(), status: 'waiting', text: LOCAL_STAGE.preparing, error: '', mediaId: '', file: null, saved: false }
    entries.set(jobId, entry); void trim()
    running = { jobId, controller }
    void (async () => {
      try {
        const result = await local.run({ jobId, id: item.id, prompt, image, signal: controller.signal, onStatus: event => { if (LOCAL_STAGE[event?.status]) { entry.status = 'running'; entry.text = LOCAL_STAGE[event.status] } } })
        await keep(entry, { mimeType: result?.mimeType, bytes: result?.bytes })
        if (!entry.file) throw Object.assign(new Error('unkept'), { publicMessage: 'It was made, but the result could not be kept for the phone. Look in ComfyUI’s output folder on the computer.' })
        entry.status = 'done'; entry.text = 'Done'
        try { onLocalResult() } catch { /* The window asks by itself too. */ }
      } catch (error) {
        const stopped = controller.signal.aborted || error?.code === 'GPU_SHARE_STOPPED'
        entry.status = stopped ? 'cancelled' : 'failed'
        entry.error = stopped ? 'Stopped.' : text(error?.publicMessage, 300) || 'Your computer could not finish it. Check ComfyUI on the computer.'
      } finally { if (running?.jobId === jobId) running = null }
    })()
    return { success: true, job: shown(entry) }
  }
  // Finished on this computer and not in the project yet: what the window saves, one at a time.
  const localResults = {
    pending: () => [...entries.values()].filter(entry => entry.local && entry.status === 'done' && entry.file && !entry.saved).map(entry => ({ jobId: entry.jobId })),
    async take(jobId) {
      const entry = entries.get(jobId)
      if (!entry?.local || !entry.file || entry.saved) return null
      const extension = EXTENSION[entry.file.mime]
      return { jobId, filename: `velorn-network-${jobId.slice(0, 12)}.${extension}`, mimeType: entry.file.mime, bytes: new Uint8Array(await fs.readFile(entry.file.path)), hostName: 'This computer', prompt: entry.prompt }
    },
    saved(jobId) { const entry = entries.get(jobId); if (entry?.local) entry.saved = true; return Boolean(entry?.local) },
  }

  // The creators' workflows this account may use right now, one card each.
  async function catalog() {
    let listed
    // Without the network there is still what this computer offers by itself.
    try { listed = await jobs.hosts() } catch (error) { const own = await yours(); if (!own.length) return failed(error, 'The Velorn network could not be reached from your computer.'); listed = { hosts: [], emailVerified: true, banned: false } }
    offered.clear()
    const cards = []
    for (const host of Array.isArray(listed?.hosts) ? listed.hosts : []) {
      for (const own of Array.isArray(host.own) ? host.own : []) {
        const cardId = `${host.hostId}.${own.id}`
        if (!CARD.test(cardId)) continue
        if (own.kind === 'audio' || own.shape === 'text-to-music') continue // Not on the phone page yet.
        const maker = text(host.maker, 40) || 'A Velorn creator'
        const card = { cardId, name: text(own.name, 60), kind: own.kind === 'video' ? 'video' : 'image', needsImage: own.needsImage === true, shape: own.shape, maker, makerId: host.hostId,
          ready: host.idle === true && !(host.waiting > 0), waiting: Number.isInteger(host.waiting) ? host.waiting : 0, yours: host.sameAccount === true,
          ...(Number.isInteger(host.remainingToday) ? { remainingToday: host.remainingToday } : {}) }
        offered.set(cardId, { hostId: host.hostId, ownId: own.id, name: card.name, kind: card.kind, needsImage: card.needsImage, maker, yours: card.yours })
        cards.push(card)
      }
    }
    return { success: true, emailVerified: listed?.emailVerified === true, banned: listed?.banned === true, cards: [...await yours(), ...cards].slice(0, 60) }
  }

  // `takePhoto(photoId)` hands over the photo the phone uploaded for this request, or null.
  async function send(input, { takePhoto = () => null } = {}) {
    if (!exact(input, ['action', 'cardId', 'prompt'], ['photoId', 'agreed']) || typeof input.cardId !== 'string' || !(CARD.test(input.cardId) || LOCAL_CARD.test(input.cardId))
      || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > LIMITS.promptChars
      || (input.agreed !== undefined && input.agreed !== true)) return invalid()
    if (LOCAL_CARD.test(input.cardId)) return local ? sendLocal(input, takePhoto) : refuse('SHARED_UNAVAILABLE', 'That workflow is not on offer right now. Look at the list again.')
    const card = offered.get(input.cardId)
    if (!card) return refuse('SHARED_UNAVAILABLE', 'That workflow is not on offer right now. Look at the list again.')
    // The same rules box the computer shows, before anything goes to someone else's computer.
    if (!card.yours && input.agreed !== true) return refuse('SHARED_RULES', 'Read the rules for shared GPUs first.')
    let image = null
    if (card.needsImage) {
      const photo = input.photoId === undefined ? null : takePhoto(input.photoId)
      if (!photo) return refuse('CREATE_PHOTO_MISSING', input.photoId === undefined ? `${card.name} starts from a picture. Add a photo first.` : 'The photo is no longer held on the computer. Add it again.')
      image = { mimeType: photo.mimeType, bytes: new Uint8Array(photo.data) }
    }
    let sent
    try { sent = await jobs.send({ hostId: card.hostId, hostName: card.maker, workflowId: card.ownId, choices: { prompt: input.prompt.trim() }, image, label: card.name, kind: card.kind, fromPhone: true }) }
    catch (error) { return failed(error, 'The job could not be sent.') }
    const entry = entries.get(sent?.job?.jobId)
    return { success: true, ...(entry ? { job: shown(entry) } : {}) }
  }

  // Where the phone's jobs stand. Looking is free and never sends anything again.
  async function list() {
    let now_
    try { now_ = await jobs.current() } catch { now_ = null }
    const active = now_?.job?.fromPhone ? entries.get(now_.job.jobId) : null
    // Finished, and the window has not collected it yet (no project open, say): fetch it for the phone.
    if (active && now_.state?.status === 'done' && !active.file && !active.keeping) { try { await jobs.collect() } catch { /* The next look tries again. */ } }
    return { success: true, busy: Boolean(now_?.job) || Boolean(running), jobs: [...entries.values()].reverse().sort((a, b) => b.createdAt - a.createdAt).map(shown) }
  }

  async function cancel(input) {
    if (!exact(input, ['action', 'jobId']) || !JOB_ID.test(input.jobId || '')) return invalid()
    if (running?.jobId === input.jobId) { running.controller.abort(); return { success: true } }
    let now_
    try { now_ = await jobs.current() } catch (error) { return failed(error, 'No answer from the Velorn network. It may still be running.') }
    if (!now_?.job?.fromPhone || now_.job.jobId !== input.jobId) return refuse('SHARED_NOT_RUNNING', 'That job is not running any more.')
    try { await jobs.cancel() } catch (error) { return failed(error, 'It could not be stopped.') }
    return { success: true }
  }

  const ACTIONS = { 'shared-catalog': input => exact(input, ['action']) ? catalog() : invalid(), 'shared-send': send, 'shared-jobs': input => exact(input, ['action']) ? list() : invalid(), 'shared-cancel': cancel }
  async function handle(input, context) {
    if (!object(input) || !Object.hasOwn(ACTIONS, input.action)) return invalid()
    try { return await ACTIONS[input.action](input, context) }
    catch { return refuse('SHARED_FAILED', 'Velorn could not finish that. Check GPU sharing on the computer before trying again.') }
  }

  async function open(mediaId) {
    const entry = typeof mediaId === 'string' ? entries.get(media.get(mediaId)) : null
    if (!entry?.file) return null
    let handle_
    try { handle_ = await fs.open(entry.file.path, 'r') } catch { return null }
    try {
      const stat = await handle_.stat()
      if (!stat.isFile() || stat.size !== entry.file.size) { await handle_.close(); return null }
      return { handle: handle_, size: stat.size, mime: entry.file.mime, name: entry.file.name }
    } catch (error) { await handle_.close(); throw error }
  }

  async function clear() {
    offered.clear(); mine.clear(); running?.controller.abort()
    const old = [...entries.values()]; entries.clear(); media.clear()
    await Promise.all(old.map(entry => entry.file ? fs.unlink(entry.file.path).catch(() => {}) : null))
  }

  return { handle, open, clear, handles: action => Object.hasOwn(ACTIONS, action), localResults }
}

// The main window saves what the phone had made on this computer into the open project.
const LOCAL_CHANNELS = ['phone-local:pending', 'phone-local:take', 'phone-local:saved']
function registerPhoneLocalIpc({ ipcMain, getMainWindow, getShared }) {
  const allowed = event => { const window = getMainWindow(); return Boolean(window && !window.isDestroyed() && event?.sender === window.webContents && event.senderFrame === window.webContents.mainFrame) }
  const handle = (channel, action) => ipcMain.handle(channel, async (event, payload) => {
    if (!allowed(event)) return { success: false, error: 'Open Velorn\'s main window.' }
    const results = getShared()?.localResults, jobId = object(payload) ? payload.jobId : undefined
    if (!results || (channel !== 'phone-local:pending' && !JOB_ID.test(jobId || ''))) return { success: false, error: 'There is nothing to save.' }
    try { return await action(results, jobId) } catch { return { success: false, error: 'That result could not be read.' } }
  })
  handle('phone-local:pending', results => ({ success: true, jobs: results.pending() }))
  handle('phone-local:take', async (results, jobId) => { const found = await results.take(jobId); return found ? { success: true, ...found } : { success: false, error: 'That result is no longer held.' } })
  handle('phone-local:saved', (results, jobId) => ({ success: results.saved(jobId) }))
  return { changed() { const window = getMainWindow(); if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('phone-local:changed') },
    dispose() { for (const channel of LOCAL_CHANNELS) ipcMain.removeHandler?.(channel) } }
}

module.exports = { createPhoneSharedGpu, registerPhoneLocalIpc, LIMITS }
