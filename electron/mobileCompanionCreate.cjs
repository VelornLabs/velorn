'use strict'
// Create (pictures and video) for the person's paired phone. The phone is a
// remote control: every request here runs through the same native Comfy Router
// manager the Create tab uses, in the project that is open on the computer.
//
// A finished picture can also be the input of the next request: the phone names
// the request it came from, and the copy already held here is used, so nothing
// travels to the phone and back.
//
// What the phone can do: read the model list and prices, ask for a quote, tap
// the priced button to generate (the tap approves up to the manager's button
// limit and no further), watch its requests, cancel one, and fetch a finished
// picture or clip. It can send ONE photo to use as the input picture.
//
// What it cannot do: name a file or path, reach the Router key, submit a plan
// it did not quote here, approve more than the button limit, or use any model
// that is not a picture or video model.
const fs = require('node:fs/promises')
const path = require('node:path')
const { randomBytes } = require('node:crypto')
const { getModel } = require('./createModels.cjs')
const { PHONE_CONFIRM_MAX_USD } = require('./comfyRouter.cjs')
const { PICTURE_TYPES, PICTURE_MAX } = require('./createRequests.cjs')

const LIMITS = Object.freeze({ chunkBytes: 256 * 1024, photoBytes: PICTURE_MAX, photoChunks: 64, photos: 2, photoMs: 15 * 60 * 1000,
  plans: 32, planMs: 10 * 60 * 1000, jobs: 24, refreshPerRead: 4, cacheFiles: 32 })
const KINDS = ['image', 'video']
const UNFINISHED = ['SUBMITTING', 'IN_QUEUE', 'IN_PROGRESS']
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value, required, optional = []) => object(value) && required.every(key => Object.hasOwn(value, key))
  && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const photoIdentifier = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)
const refuse = (code, error) => ({ success: false, code, error })
const invalid = () => refuse('CREATE_INVALID', 'That Create request could not be read. Reload the page and try again.')
// Manager failures already carry wording written for the person; pass only that.
const failed = result => refuse(typeof result?.code === 'string' ? result.code.slice(0, 64) : 'CREATE_FAILED',
  typeof result?.error === 'string' && result.error ? result.error.slice(0, 600) : 'Velorn could not finish that. Check Create on the computer before trying again.')

// `shared` (mobileCompanionSharedGpu.cjs) adds free jobs on other creators' GPUs through the same routes: its actions
// start with `shared-`, it borrows the photo upload, and its results are served by the same opaque media ids.
function createMobileCreateBridge({ getManager, isBusy = () => false, cacheDir, now = Date.now, shared = null } = {}) {
  if (typeof getManager !== 'function' || !path.isAbsolute(cacheDir || '')) throw new TypeError('The phone Create bridge needs the Router manager and a private cache folder.')
  const photos = new Map(), plans = new Map()
  // Opaque media IDs, never job IDs or file names, are what the phone asks for.
  const mediaByJob = new Map(), jobByMedia = new Map(), files = new Map(), fetching = new Map()

  function card(job) {
    if (!object(job) || !identifier(job.jobId) || job.create !== true || !KINDS.includes(job.kind)) return null
    const finished = job.status === 'COMPLETED'
    if (finished && !mediaByJob.has(job.jobId)) { const id = randomBytes(24).toString('hex'); mediaByJob.set(job.jobId, id); jobByMedia.set(id, job.jobId) }
    // Start collecting the result as soon as it exists, so the phone's first
    // request for it does not have to wait for the download from Comfy.
    if (finished && !files.has(job.jobId)) void ensureFile(job.jobId).catch(() => {})
    const media = finished ? mediaByJob.get(job.jobId) : null
    return { jobId: job.jobId, modelId: job.modelId, modelLabel: job.modelLabel, kind: job.kind, status: job.status,
      createdAt: job.createdAt, updatedAt: job.updatedAt,
      ...(typeof job.estimateUsd === 'number' ? { estimateUsd: job.estimateUsd } : {}),
      ...(typeof job.chargedUsd === 'number' ? { chargedUsd: job.chargedUsd } : {}),
      ...(typeof job.errorMessage === 'string' ? { errorMessage: job.errorMessage.slice(0, 600) } : {}),
      ...(typeof job.errorType === 'string' ? { errorType: job.errorType.slice(0, 64) } : {}),
      needsReconnect: job.needsReconnect === true, cancellationRequested: job.cancellationRequested === true,
      savedToProject: Boolean(job.importedAssetId),
      ...(media ? { ready: files.has(job.jobId), url: `/media/create/${media}`, downloadUrl: `/media/create/${media}/download` } : {}) }
  }

  async function catalog() {
    const manager = getManager()
    const listed = await manager.models({})
    if (listed?.success !== true) return failed(listed)
    const status = await manager.status({})
    return { success: true, connected: status?.success === true && status.configured === true,
      policy: status?.success === true && ['local-only', 'ask-cloud'].includes(status.policy) ? status.policy : 'unavailable',
      sharedGpu: Boolean(shared), buttonApprovalUsd: listed.buttonApprovalUsd, phoneConfirmMaxUsd: PHONE_CONFIRM_MAX_USD, resultAsInput: true, pricesAsOf: listed.pricesAsOf,
      models: listed.models.filter(model => KINDS.includes(model.kind)) }
  }

  async function quote(input) {
    if (!exact(input, ['action', 'modelId', 'choices'], ['count', 'photoId', 'fromJobId']) || !object(input.choices) || Object.hasOwn(input.choices, 'picture')
      || (input.photoId !== undefined && input.fromJobId !== undefined)) return invalid()
    if (!KINDS.includes(getModel(input.modelId)?.kind)) return refuse('CREATE_INVALID', 'That model is not available on the phone.')
    let choices = input.choices
    if (input.fromJobId !== undefined) {
      // Only a finished picture this bridge has already shown the phone, in the open project.
      if (!identifier(input.fromJobId) || !mediaByJob.has(input.fromJobId)) return refuse('CREATE_RESULT_UNAVAILABLE', 'That picture is no longer available to reuse. Add it as a photo instead.')
      let entry, data
      try { entry = await ensureFile(input.fromJobId); data = entry ? await fs.readFile(entry.file) : null } catch { data = null }
      if (!entry || !data || !PICTURE_TYPES.includes(entry.mime) || data.length !== entry.size) return refuse('CREATE_RESULT_UNAVAILABLE', 'That picture is no longer available to reuse. Add it as a photo instead.')
      if (data.length > PICTURE_MAX) return refuse('CREATE_PHOTO_TOO_LARGE', 'That picture is larger than 10 MB, which is more than a model takes as an input. Make it again at a smaller size to reuse it.')
      choices = { ...choices, picture: { mimeType: entry.mime, base64: data.toString('base64') } }
    }
    if (input.photoId !== undefined) {
      const photo = photoIdentifier(input.photoId) ? photos.get(input.photoId) : null
      if (!photo?.data || now() - photo.createdAt > LIMITS.photoMs) return refuse('CREATE_PHOTO_MISSING', 'The photo is no longer held on the computer. Add it again.')
      choices = { ...choices, picture: { mimeType: photo.mimeType, base64: photo.data.toString('base64') } }
    }
    const result = await getManager().previewCreate({ modelId: input.modelId, choices, ...(input.count !== undefined ? { count: input.count } : {}) })
    if (result?.success !== true) return failed(result)
    for (const [id, createdAt] of plans) if (now() - createdAt > LIMITS.planMs) plans.delete(id)
    while (plans.size >= LIMITS.plans) plans.delete(plans.keys().next().value)
    plans.set(result.planId, now())
    // How this request can be approved from the phone: one tap on the priced
    // button, a second confirmation of the exact price, or only on the computer.
    const estimate = result.estimate || null
    const ceiling = estimate ? Math.max(estimate.usd, estimate.range?.high ?? 0) : null
    const approval = result.buttonApproval === true ? 'tap' : ceiling !== null && ceiling <= PHONE_CONFIRM_MAX_USD ? 'confirm' : 'computer'
    // The prompt and choices are the phone's own; they are not echoed back.
    return { success: true, approval, planId: result.planId, modelId: result.modelId, modelLabel: result.modelLabel, kind: result.kind, count: result.count,
      estimate: result.estimate || null, buttonApproval: result.buttonApproval === true, policy: result.policy,
      refusalCharged: result.refusalCharged === true, summary: result.summary }
  }

  async function generate(input) {
    if (!exact(input, ['action', 'planId'], ['confirmedUsd']) || !identifier(input.planId)
      || (input.confirmedUsd !== undefined && !(typeof input.confirmedUsd === 'number' && Number.isFinite(input.confirmedUsd) && input.confirmedUsd > 0))) return invalid()
    if (!plans.has(input.planId)) return refuse('CREATE_PLAN_INVALID', 'That price check is no longer current. Check the price again before generating.')
    const result = await getManager().submitCreateRemote({ planId: input.planId, ...(input.confirmedUsd !== undefined ? { confirmedUsd: input.confirmedUsd } : {}) })
    const cards = (Array.isArray(result?.jobs) ? result.jobs : result?.job ? [result.job] : []).map(card).filter(Boolean)
    if (result?.success !== true) return { ...failed(result), ...(cards.length ? { jobs: cards } : {}) }
    return { success: true, jobs: cards, ...(result.repeated ? { repeated: true } : {}),
      ...(result.partial ? { partial: true, stopped: failed(result.stopped).error } : {}) }
  }

  async function jobs(input) {
    if (!exact(input, ['action'])) return invalid()
    const manager = getManager()
    const listed = await manager.list({})
    if (listed?.success !== true) return failed(listed)
    const mine = listed.jobs.filter(job => job.create === true && KINDS.includes(job.kind)).slice(0, LIMITS.jobs)
    let refreshed = 0
    for (let index = 0; index < mine.length && refreshed < LIMITS.refreshPerRead; index++) {
      const job = mine[index]
      if (!UNFINISHED.includes(job.status) || !job.canRefresh || job.needsReconnect || job.retryAfterMs > 0) continue
      refreshed++
      const result = await manager.refresh({ jobId: job.jobId })
      if (result?.success === true && object(result.job)) mine[index] = result.job
    }
    return { success: true, jobs: mine.map(card).filter(Boolean) }
  }

  async function cancel(input) {
    if (!exact(input, ['action', 'jobId']) || !identifier(input.jobId)) return invalid()
    const result = await getManager().cancel({ jobId: input.jobId })
    const shown = card(result?.job)
    return result?.success === true ? { success: true, ...(shown ? { job: shown } : {}), ...(typeof result.summary === 'string' ? { summary: result.summary.slice(0, 300) } : {}) }
      : { ...failed(result), ...(shown ? { job: shown } : {}) }
  }

  // A photo the phone finished uploading, for a shared GPU job that starts from a picture.
  const takePhoto = photoId => { const photo = photoIdentifier(photoId) ? photos.get(photoId) : null; return photo?.data && now() - photo.createdAt <= LIMITS.photoMs ? { mimeType: photo.mimeType, data: photo.data } : null }
  const ACTIONS = { catalog: input => exact(input, ['action']) ? catalog() : invalid(), quote, generate, jobs, cancel }
  async function handle(input) {
    if (object(input) && shared?.handles(input.action)) {
      if (isBusy() && input.action === 'shared-send') return refuse('CREATE_EXPORT_BUSY', 'Velorn is exporting on the computer. Try again when the export has finished.')
      return shared.handle(input, { takePhoto })
    }
    if (!object(input) || !Object.hasOwn(ACTIONS, input.action)) return invalid()
    if (isBusy() && ['quote', 'generate'].includes(input.action)) return refuse('CREATE_EXPORT_BUSY', 'Velorn is exporting on the computer. Try again when the export has finished.')
    try { return await ACTIONS[input.action](input) }
    catch { return refuse('CREATE_FAILED', 'Velorn could not finish that. Check Create on the computer before trying again.') }
  }

  // One photo arrives as a few numbered pieces, in order. A repeated piece is
  // acknowledged without being stored twice, so a retry after a lost reply is safe.
  function upload(input) {
    if (!exact(input, ['photoId', 'index', 'total', 'mimeType', 'data']) || !photoIdentifier(input.photoId)
      || !Number.isInteger(input.total) || input.total < 1 || input.total > LIMITS.photoChunks
      || !Number.isInteger(input.index) || input.index < 0 || input.index >= input.total
      || !PICTURE_TYPES.includes(input.mimeType) || typeof input.data !== 'string' || !input.data.length
      || input.data.length > 4 * Math.ceil(LIMITS.chunkBytes / 3) || input.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.data)) return invalid()
    const piece = Buffer.from(input.data, 'base64')
    if (!piece.length || piece.length > LIMITS.chunkBytes || piece.toString('base64') !== input.data) return invalid()
    for (const [id, photo] of photos) if (now() - photo.createdAt > LIMITS.photoMs) photos.delete(id)
    let photo = photos.get(input.photoId)
    if (!photo) {
      if (input.index !== 0) return refuse('CREATE_PHOTO_MISSING', 'The photo upload was interrupted. Add the photo again.')
      while (photos.size >= LIMITS.photos) photos.delete(photos.keys().next().value)
      photo = { mimeType: input.mimeType, total: input.total, pieces: [], bytes: 0, createdAt: now(), data: null }
      photos.set(input.photoId, photo)
    }
    if (photo.mimeType !== input.mimeType || photo.total !== input.total || input.index > photo.pieces.length) { photos.delete(input.photoId); return invalid() }
    if (input.index < photo.pieces.length) return { success: true, received: photo.pieces.length, complete: Boolean(photo.data) }
    photo.bytes += piece.length
    if (photo.bytes > LIMITS.photoBytes) { photos.delete(input.photoId); return refuse('CREATE_PHOTO_TOO_LARGE', 'The photo is larger than 10 MB.') }
    photo.pieces.push(piece)
    if (photo.pieces.length === photo.total) { photo.data = Buffer.concat(photo.pieces); photo.pieces = Array(photo.total).fill(null) }
    return { success: true, received: photo.pieces.length, complete: Boolean(photo.data) }
  }

  // Collects a finished result from Comfy once and keeps it in Velorn's own
  // data folder for the phone. The project gets its own copy when the Create
  // tab imports the request; this cache is only what the phone is shown.
  // Files left by an earlier run are not tracked any more; remove them once.
  let swept = null
  const sweep = () => swept || (swept = fs.readdir(cacheDir).then(names => Promise.all(names
    .filter(name => /^[A-Za-z0-9_-]{1,128}\.(?:png|jpg|webp|mp4|mov)(?:\.[a-f0-9]{12}\.part)?$/.test(name))
    .map(name => fs.unlink(path.join(cacheDir, name)).catch(() => {}))), () => {}))
  function ensureFile(jobId) {
    if (files.has(jobId)) return Promise.resolve(files.get(jobId))
    if (fetching.has(jobId)) return fetching.get(jobId)
    const work = (async () => {
      await sweep()
      const output = await getManager().output({ jobId })
      if (output?.success !== true || !(output.bytes instanceof Uint8Array) || !output.bytes.length || typeof output.mimeType !== 'string'
        || !/^(?:image\/(?:png|jpeg|webp)|video\/(?:mp4|quicktime))$/.test(output.mimeType)) return null
      await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 })
      const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/quicktime': 'mov' }[output.mimeType]
      const file = path.join(cacheDir, `${jobId}.${extension}`)
      const temporary = `${file}.${randomBytes(6).toString('hex')}.part`
      await fs.writeFile(temporary, output.bytes, { mode: 0o600, flag: 'wx' })
      await fs.rename(temporary, file)
      const entry = { file, mime: output.mimeType, name: `velorn-create-${jobId.slice(0, 8)}.${extension}`, size: output.bytes.length }
      files.set(jobId, entry)
      while (files.size > LIMITS.cacheFiles) {
        const [oldest, old] = files.entries().next().value
        files.delete(oldest); await fs.unlink(old.file).catch(() => {})
      }
      return entry
    })().finally(() => fetching.delete(jobId))
    fetching.set(jobId, work)
    return work
  }

  async function open(mediaId) {
    const jobId = typeof mediaId === 'string' ? jobByMedia.get(mediaId) : null
    if (!jobId) return shared ? shared.open(mediaId) : null
    let entry
    try { entry = await ensureFile(jobId) } catch { return null }
    if (!entry) return null
    let handle
    try { handle = await fs.open(entry.file, 'r') } catch { files.delete(jobId); return null }
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size !== entry.size) { await handle.close(); files.delete(jobId); return null }
      return { handle, size: stat.size, mime: entry.mime, name: entry.name }
    } catch (error) { await handle.close(); throw error }
  }

  async function clear() {
    photos.clear(); plans.clear(); mediaByJob.clear(); jobByMedia.clear()
    await shared?.clear()
    const old = [...files.values()]; files.clear()
    await Promise.all(old.map(entry => fs.unlink(entry.file).catch(() => {})))
  }

  return { handle, upload, open, clear }
}

module.exports = { createMobileCreateBridge, LIMITS }
