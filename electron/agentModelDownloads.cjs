'use strict'

const nativeFs = require('node:fs')
const fsPromises = require('node:fs/promises')
const path = require('node:path')
const { randomUUID, createHash } = require('node:crypto')
const { isIP } = require('node:net')

// Boundary: untrusted remote URLs/model arguments and incidental filesystem
// changes, not a hostile same-OS-user process controlling Velorn's directories.
// Portable Node does not expose descriptor-relative linkat/unlinkat. Identity
// rechecks therefore detect ordinary replacement, not every adversarial race.
// Linux additionally pins the destination directory with /proc/self/fd.

const MODEL_SUBDIRS = Object.freeze(['checkpoints', 'diffusion_models', 'unet', 'vae', 'text_encoders', 'clip', 'clip_vision', 'loras', 'controlnet', 'upscale_models', 'audio_encoders', 'model_patches', 'embeddings', 'style_models', 'gligen', 'photomaker'])
const LIMITS = Object.freeze({ maxBytes: 64 * 1024 ** 3, timeoutMs: 30 * 60 * 1000, previewTtlMs: 4 * 60 * 1000, previews: 64, active: 2, queued: 4, jobs: 32, headerBytes: 16 * 1024 ** 2 })
const fault = (code, message) => Object.assign(new Error(message), { code, safeModelDownloadError: true })
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const identity = stat => `${stat.dev}:${stat.ino}`
const terminal = job => ['completed', 'failed', 'cancelled'].includes(job.state)
const inside = (parent, child) => { const relative = path.relative(parent, child); return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative) }

function checkAbort(signal) {
  if (signal?.aborted) throw fault(signal.reason === 'timeout' ? 'DOWNLOAD_TIMEOUT' : 'CANCELLED', signal.reason === 'timeout' ? 'The model download exceeded its time limit.' : 'The model download was cancelled.')
}
function abortable(value, signal) {
  checkAbort(signal)
  return new Promise((resolve, reject) => {
    const abort = () => { try { checkAbort(signal) } catch (error) { reject(error) } }
    signal?.addEventListener('abort', abort, { once: true })
    Promise.resolve(value).then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort))
  })
}
function ownerKey(owner) {
  if (typeof owner !== 'string' || !owner || owner.length > 4096) throw fault('INVALID_OWNER', 'A host-owned project session is required.')
  return owner
}
function normalizeArgs(args) {
  if (!object(args)) throw fault('INVALID_DOWNLOAD', 'Provide model download arguments.')
  const allowed = new Set(['url', 'targetSubdir', 'filename', 'maxBytes', 'expectedSha256', 'previewToken', 'previewOnly'])
  if (Object.keys(args).some(key => !allowed.has(key))) throw fault('INVALID_DOWNLOAD', 'Only the public URL, model category, filename, byte limit, and optional SHA-256 are accepted.')
  let url
  try { url = new URL(args.url) } catch { throw fault('INVALID_URL', 'Provide a public HTTPS model URL.') }
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  // The shared public client also verifies DNS/IPs and every redirect. This
  // synchronous check rejects credentials and obvious local targets at preview.
  if (typeof args.url !== 'string' || args.url.length > 4096 || /[\u0000-\u0020\u007f\\]/.test(args.url)
    || url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password || url.hash
    || isIP(host) || host.startsWith('[') || !host.includes('.') || url.hostname.endsWith('.') || /(?:^|\.)(?:localhost|local|internal|onion|test|invalid)$|(?:^|\.)home\.arpa$/.test(host)
    || [...url.searchParams.keys()].some(key => /(?:token|secret|password|credential|signature|authorization|api[-_]?key|^auth$|^x-amz-|^x-goog-)/i.test(key))) {
    throw fault('INVALID_URL', 'Use a public HTTPS URL on port 443 without credentials, signed query parameters, or a fragment.')
  }
  const filename = args.filename
  if (typeof filename !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,179}\.(safetensors|gguf)$/i.test(filename)
    || /[. ]$/.test(filename) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(filename.split('.')[0].replace(/[ .]+$/, ''))
    || filename.includes('..') || filename !== path.basename(filename)) {
    throw fault('INVALID_FILENAME', 'Use a portable basename ending in .safetensors or .gguf, without paths, reserved device names, or traversal.')
  }
  if (!MODEL_SUBDIRS.includes(args.targetSubdir)) throw fault('INVALID_TARGET', 'Choose a supported ComfyUI models category, not an arbitrary path.')
  if (!Number.isSafeInteger(args.maxBytes) || args.maxBytes < 1 || args.maxBytes > LIMITS.maxBytes) throw fault('INVALID_LIMIT', 'Specify a positive maximum download size of at most 64 GiB.')
  if (args.expectedSha256 != null && (typeof args.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(args.expectedSha256))) throw fault('INVALID_HASH', 'The optional SHA-256 must contain exactly 64 hexadecimal characters.')
  return { url: url.href, targetSubdir: args.targetSubdir, filename, maxBytes: args.maxBytes, expectedSha256: args.expectedSha256?.toLowerCase() || null }
}
function publicUrl(value) { const url = new URL(value); return `${url.origin}${url.pathname}` }

function createModelDownloadManager({ getComfyRoot, webClient, fs = fsPromises, now = Date.now, assertCanStart = async () => {},
  timeoutMs = LIMITS.timeoutMs, previewTtlMs = LIMITS.previewTtlMs, maxActive = LIMITS.active,
  maxQueued = LIMITS.queued, maxJobs = LIMITS.jobs, platform = process.platform } = {}) {
  if (typeof getComfyRoot !== 'function') throw new TypeError('getComfyRoot is required')
  timeoutMs = Math.max(1, Math.min(LIMITS.timeoutMs, timeoutMs))
  previewTtlMs = Math.max(1, Math.min(LIMITS.previewTtlMs, previewTtlMs))
  maxActive = Math.max(1, Math.min(LIMITS.active, maxActive))
  maxQueued = Math.max(0, Math.min(LIMITS.queued, maxQueued))
  maxJobs = Math.max(maxActive + maxQueued, Math.min(LIMITS.jobs, maxJobs))
  const previews = new Map(); const jobs = new Map(); const reservations = new Set()
  let disposed = false; let active = 0
  function available() { if (disposed) throw fault('DISPOSED', 'The model download manager is closed.') }
  async function exists(file) { try { return await fs.lstat(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
  async function safeDirectory(directory, parent) {
    const stat = await fs.lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fault('UNSAFE_PATH', 'Model directories must be real directories, not symbolic links.')
    const real = await fs.realpath(directory)
    if (parent && !inside(parent, real)) throw fault('UNSAFE_PATH', 'The model destination must remain inside the configured ComfyUI models folder.')
    return { path: real, id: identity(stat) }
  }
  async function inspectRoot(args) {
    const configured = await getComfyRoot()
    if (typeof configured !== 'string' || !configured || !path.isAbsolute(configured) || configured.includes('\0')) throw fault('INVALID_ROOT', 'Configure an existing local ComfyUI root first.')
    const configuredPath = path.resolve(configured)
    let root, models, main, target
    try {
      const realRoot = await fs.realpath(configuredPath)
      root = await safeDirectory(realRoot)
      main = await fs.lstat(path.join(root.path, 'main.py'))
      if (!main.isFile() || main.isSymbolicLink()) throw fault('INVALID_ROOT', 'The configured ComfyUI root must contain a regular main.py and models directory.')
      models = await safeDirectory(path.join(root.path, 'models'), root.path)
      const targetPath = path.join(models.path, args.targetSubdir)
      target = await exists(targetPath) ? await safeDirectory(targetPath, models.path) : null
    } catch (error) {
      if (error.safeModelDownloadError) throw error
      throw fault('INVALID_ROOT', 'The configured ComfyUI root or model directory is missing or inaccessible.')
    }
    return { configuredPath, root, main: identity(main), models, target }
  }
  const sameRoot = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  async function assertRoot(job) {
    const actual = await inspectRoot(job.args)
    if (!sameRoot(job.root, actual)) throw fault('ROOT_CHANGED', 'The configured ComfyUI root or destination changed after preview. Inspect and approve a new preview.')
    return actual
  }
  async function assertDestination(root, args) {
    if (!root.target) return
    if (await exists(path.join(root.target.path, args.filename))) throw fault('DESTINATION_EXISTS', 'The destination already exists. Existing files are never overwritten.')
    // Also reject case aliases so a plan is portable to case-insensitive disks.
    const names = await fs.readdir(root.target.path)
    if (names.some(name => name.replace(/[. ]+$/, '').toLowerCase() === args.filename.toLowerCase())) throw fault('DESTINATION_EXISTS', 'A case-insensitive alias of the destination already exists.')
  }
  async function checkSpace(root, args) {
    if (typeof fs.statfs !== 'function') return null
    let stat
    try { stat = await fs.statfs(root.target?.path || root.models.path) } catch { return null }
    const free = Number(stat.bavail) * Number(stat.bsize)
    if (!Number.isFinite(free)) return null
    if (free < args.maxBytes) throw fault('INSUFFICIENT_SPACE', 'There is not enough free space for the approved maximum download size.')
    return free
  }
  function prunePreviews() {
    for (const [key, value] of previews) if (value.expiresAt <= now()) previews.delete(key)
    while (previews.size >= LIMITS.previews) previews.delete(previews.keys().next().value)
  }
  function view(job) {
    return { jobId: job.id, state: job.state, source: publicUrl(job.args.url), targetSubdir: job.args.targetSubdir,
      filename: job.args.filename, maxBytes: job.args.maxBytes, expectedSha256: job.args.expectedSha256,
      downloadedBytes: job.bytes, totalBytes: job.totalBytes, sha256: job.sha256 || null,
      createdAt: job.createdAt, startedAt: job.startedAt || null, finishedAt: job.finishedAt || null,
      ...(job.error ? { error: job.error } : {}), ...(job.warning ? { warning: job.warning } : {}) }
  }
  async function preview(args, { signal, owner } = {}) {
    available(); const key = ownerKey(owner); checkAbort(signal)
    const normalized = normalizeArgs(args)
    const root = await inspectRoot(normalized)
    if (!root.target) throw fault('MISSING_CATEGORY', 'The selected ComfyUI model category must already exist. Create it through normal setup, then preview again.')
    await assertDestination(root, normalized)
    const freeBytes = await checkSpace(root, normalized)
    checkAbort(signal); available(); prunePreviews()
    const token = randomUUID(); const expiresAt = now() + previewTtlMs
    previews.set(token, { args: normalized, root, owner: key, expiresAt })
    return { previewOnly: true, previewToken: token, expiresAt, ...normalized,
      root: root.root.path, destination: path.join(root.models.path, normalized.targetSubdir, normalized.filename),
      freeBytes,
      note: 'Approval downloads only this model file. It never overwrites, installs code, loads a model, or restarts ComfyUI.' }
  }
  function getJob(jobId, owner) {
    const job = jobs.get(jobId)
    if (!job || job.owner !== owner) throw fault('UNKNOWN_JOB', 'No model download with that ID belongs to this project session.')
    return job
  }
  function detach(job) { job.detach?.(); job.detach = null }
  function finish(job, state, error) {
    job.state = state; job.finishedAt = now(); clearTimeout(job.timer); detach(job)
    if (error) job.error = error.safeModelDownloadError ? { code: error.code, message: error.message }
      : { code: 'DOWNLOAD_FAILED', message: 'The public model download failed. Check its source and destination before trying again.' }
    reservations.delete(job.reservation)
  }
  async function start(args, { signal, owner } = {}) {
    available(); const key = ownerKey(owner); checkAbort(signal)
    if (!object(args) || typeof args.previewToken !== 'string') throw fault('PREVIEW_REQUIRED', 'Preview and approve this exact download before starting it.')
    const plan = previews.get(args.previewToken)
    if (!plan || plan.owner !== key || plan.expiresAt <= now()) throw fault('PREVIEW_REQUIRED', 'The model download preview is missing, expired, or belongs to another project session.')
    const fields = Object.keys(args).filter(field => !['previewToken', 'previewOnly'].includes(field))
    if (fields.length && JSON.stringify(normalizeArgs(args)) !== JSON.stringify(plan.args)) throw fault('PREVIEW_CHANGED', 'Download arguments changed after preview. Request a new preview.')
    // Consume before awaiting: two concurrent starts cannot reuse one approval.
    previews.delete(args.previewToken)
    await assertRoot(plan); await assertDestination(plan.root, plan.args); await checkSpace(plan.root, plan.args)
    checkAbort(signal); available()
    const pending = [...jobs.values()].filter(job => !terminal(job)).length
    if (pending >= maxActive + maxQueued) throw fault('DOWNLOAD_LIMIT', 'The model download queue is full. Wait or cancel an existing job.')
    const reservation = `${plan.root.models.path}/${plan.args.targetSubdir}/${plan.args.filename}`.toLowerCase()
    if (reservations.has(reservation)) throw fault('DESTINATION_BUSY', 'A download already owns this model destination.')
    while (jobs.size >= maxJobs) {
      const oldest = [...jobs.values()].find(terminal)
      if (!oldest) throw fault('DOWNLOAD_LIMIT', 'The model download job limit was reached.')
      jobs.delete(oldest.id)
    }
    const job = { id: randomUUID(), owner: key, args: plan.args, root: plan.root, state: 'queued', bytes: 0,
      totalBytes: null, createdAt: now(), reservation, controller: new AbortController(), partial: null }
    reservations.add(reservation); jobs.set(job.id, job)
    job.timer = setTimeout(() => {
      job.controller.abort('timeout')
      if (job.state === 'queued') { finish(job, 'failed', fault('DOWNLOAD_TIMEOUT', 'The model download exceeded its time limit.')); pump() }
    }, timeoutMs); job.timer.unref?.()
    const onAbort = () => {
      // A successful agent response finishes its turn, not its background jobs.
      if (signal.reason === 'finished') { detach(job); return }
      job.controller.abort(signal.reason)
      if (job.state === 'queued') { finish(job, 'cancelled', fault('CANCELLED', 'The model download was cancelled.')); pump() }
    }
    if (signal) { signal.addEventListener('abort', onAbort, { once: true }); job.detach = () => signal.removeEventListener('abort', onAbort); if (signal.aborted) onAbort() }
    queueMicrotask(pump)
    return view(job)
  }
  async function anchor(job) {
    await assertRoot(job)
    if (!job.root.target) throw fault('MISSING_CATEGORY', 'The selected ComfyUI model category must already exist.')
    await assertDestination(job.root, job.args); await checkSpace(job.root, job.args)
    const target = job.root.target.path
    // Windows cannot portably open a directory through Node's file API. Keep
    // the same static realpath/symlink and before/after identity checks there.
    if (platform === 'win32') { await assertRoot(job); return { handle: null, base: target } }
    const handle = await fs.open(target, nativeFs.constants.O_RDONLY | (nativeFs.constants.O_DIRECTORY || 0) | (nativeFs.constants.O_NOFOLLOW || 0))
    try {
      if (identity(await handle.stat()) !== job.root.target.id) throw fault('ROOT_CHANGED', 'The model destination changed before the download started.')
      await assertRoot(job)
      // Linux's descriptor-relative pathname pins the directory across renames
      // and symlink replacement. Other platforms get repeated identity guards.
      const base = platform === 'linux' ? `/proc/self/fd/${handle.fd}` : target
      if (platform === 'linux' && await fs.realpath(base) !== target) throw fault('UNSAFE_PATH', 'Could not securely pin the model destination directory.')
      return { handle, base }
    } catch (error) { await handle.close(); throw error }
  }
  async function validateHeader(file, args, bytes) {
    const prefix = Buffer.alloc(24); const { bytesRead } = await file.read(prefix, 0, prefix.length, 0)
    if (/\.gguf$/i.test(args.filename)) {
      if (bytesRead < 24 || prefix.toString('ascii', 0, 4) !== 'GGUF' || ![2, 3].includes(prefix.readUInt32LE(4))) throw fault('INVALID_MODEL', 'The response is not a supported GGUF model file.')
      return
    }
    if (bytesRead < 10) throw fault('INVALID_MODEL', 'The response is not a safetensors model file.')
    const length = prefix.readBigUInt64LE(0)
    if (length < 2n || length > BigInt(LIMITS.headerBytes) || length > BigInt(bytes - 8)) throw fault('INVALID_MODEL', 'The safetensors header is missing or exceeds the safe limit.')
    const header = Buffer.alloc(Number(length)); let offset = 0
    while (offset < header.length) {
      const result = await file.read(header, offset, header.length - offset, offset + 8)
      if (!result.bytesRead) throw fault('INVALID_MODEL', 'The safetensors header is incomplete.')
      offset += result.bytesRead
    }
    let tensors
    try { tensors = JSON.parse(header.toString('utf8')) } catch { throw fault('INVALID_MODEL', 'The response has an invalid safetensors header.') }
    if (!object(tensors) || !Object.keys(tensors).some(key => key !== '__metadata__')) throw fault('INVALID_MODEL', 'The safetensors response does not contain tensors.')
    for (const [key, tensor] of Object.entries(tensors)) {
      if (key === '__metadata__') {
        if (!object(tensor) || Object.values(tensor).some(value => typeof value !== 'string')) throw fault('INVALID_MODEL', 'Invalid safetensors metadata.')
        continue
      }
      if (!object(tensor) || typeof tensor.dtype !== 'string' || !/^[A-Z0-9_]{1,32}$/.test(tensor.dtype)
        || !Array.isArray(tensor.shape) || tensor.shape.some(size => !Number.isSafeInteger(size) || size < 0)
        || !Array.isArray(tensor.data_offsets) || tensor.data_offsets.length !== 2
        || tensor.data_offsets.some(value => !Number.isSafeInteger(value) || value < 0)
        || tensor.data_offsets[0] > tensor.data_offsets[1] || tensor.data_offsets[1] > bytes - 8 - header.length) throw fault('INVALID_MODEL', 'Invalid safetensors tensor bounds.')
    }
  }
  async function cleanPartial(job) {
    if (!job.partial || !job.fileIdentity) return
    const stat = await exists(job.partial)
    if (stat && stat.isFile() && !stat.isSymbolicLink() && identity(stat) === job.fileIdentity) await fs.unlink(job.partial)
    else if (stat) job.warning = 'A changed partial-file path was left untouched. Inspect the model directory manually.'
  }
  async function run(job) {
    const signal = job.controller.signal; let dir, file, response, iterator, completed = false, failure
    try {
      checkAbort(signal); dir = await anchor(job); checkAbort(signal)
      job.partial = path.join(dir.base, `.velorn-model-${job.id}.partial`)
      file = await fs.open(job.partial, nativeFs.constants.O_CREAT | nativeFs.constants.O_EXCL | nativeFs.constants.O_RDWR | (nativeFs.constants.O_NOFOLLOW || 0), 0o600)
      job.fileIdentity = identity(await file.stat())
      await assertRoot(job); checkAbort(signal)
      webClient ||= require('./agentResearchWeb.cjs').createPublicWebClient({ timeoutMs, maxBytes: LIMITS.maxBytes })
      // Queueing is not network admission. Export/project availability can
      // change while this job waits or prepares its guarded partial file.
      try { await assertCanStart() }
      catch { throw fault('DOWNLOAD_UNAVAILABLE', 'Model downloading is no longer available in the current Velorn state. Inspect before requesting a new approved download.') }
      checkAbort(signal)
      response = await abortable(webClient.open(job.args.url, { signal, method: 'GET', maxBytes: job.args.maxBytes, timeoutMs }), signal)
      if (response.stream?.[Symbol.asyncIterator]) iterator = response.stream[Symbol.asyncIterator]()
      if (response.statusCode !== 200 || !response.stream?.[Symbol.asyncIterator]) throw fault('DOWNLOAD_RESPONSE', 'The public server did not return a complete model download (HTTP 200).')
      const headers = Object.fromEntries(Object.entries(response.headers || {}).map(([key, value]) => [key.toLowerCase(), value]))
      if (headers['content-encoding'] && String(headers['content-encoding']).toLowerCase() !== 'identity') throw fault('DOWNLOAD_RESPONSE', 'Compressed HTTP transfer content is not supported for model downloads.')
      if (/text\/|json|html|xml/i.test(String(headers['content-type'] || ''))) throw fault('INVALID_MODEL', 'The server returned a page or text response, not a model file.')
      const length = headers['content-length']
      if (length != null && (!/^\d+$/.test(String(length)) || !Number.isSafeInteger(Number(length)) || Number(length) > job.args.maxBytes || Number(length) < 1)) throw fault('DOWNLOAD_TOO_LARGE', 'The response size is invalid or exceeds the approved maximum.')
      job.totalBytes = length == null ? null : Number(length)
      const hash = createHash('sha256')
      while (true) {
        const next = await abortable(iterator.next(), signal); checkAbort(signal)
        if (next.done) break
        if (!(next.value instanceof Uint8Array)) throw fault('DOWNLOAD_RESPONSE', 'The model server returned an unsupported stream.')
        const chunk = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength)
        if (job.bytes + chunk.length > job.args.maxBytes) throw fault('DOWNLOAD_TOO_LARGE', 'The model download exceeded the approved byte limit.')
        let written = 0
        while (written < chunk.length) {
          checkAbort(signal)
          const result = await file.write(chunk, written, chunk.length - written)
          if (!result.bytesWritten) throw fault('DOWNLOAD_WRITE_FAILED', 'The model partial file could not be written.')
          written += result.bytesWritten
        }
        hash.update(chunk); job.bytes += chunk.length
      }
      if (!job.bytes || (job.totalBytes !== null && job.bytes !== job.totalBytes)) throw fault('DOWNLOAD_INCOMPLETE', 'The model response ended before its advertised size.')
      job.sha256 = hash.digest('hex')
      if (job.args.expectedSha256 && job.sha256 !== job.args.expectedSha256) throw fault('HASH_MISMATCH', 'The downloaded file does not match the approved SHA-256.')
      await validateHeader(file, job.args, job.bytes); await file.sync(); checkAbort(signal)
      await assertRoot(job); await assertDestination(job.root, job.args); checkAbort(signal)
      const stat = await fs.lstat(job.partial)
      if (!stat.isFile() || stat.isSymbolicLink() || identity(stat) !== job.fileIdentity) throw fault('PARTIAL_CHANGED', 'The download partial file changed unexpectedly; it was not promoted.')
      checkAbort(signal)
      // link is atomic and never replaces an existing name. rename is unsafe:
      // POSIX rename would silently replace an existing model at this boundary.
      try { await fs.link(job.partial, path.join(dir.base, job.args.filename)) }
      catch (error) {
        if (error.code === 'EEXIST') throw fault('DESTINATION_EXISTS', 'The destination appeared during download. It was not overwritten.')
        throw fault('PROMOTION_UNSUPPORTED', 'This filesystem could not safely promote the model without overwriting. No final model file was installed.')
      }
      completed = true
    } catch (error) { failure = error }
    finally {
      response?.stream?.destroy?.()
      if (iterator?.return) { try { Promise.resolve(iterator.return()).catch(() => {}) } catch {} }
      try { await file?.close() } catch { if (!failure && !completed) failure = fault('DOWNLOAD_WRITE_FAILED', 'The model partial file could not be closed.') }
      try { await cleanPartial(job) } catch { job.warning = 'The owned partial file could not be removed. Inspect the model directory manually.' }
      try { await dir?.handle?.close() } catch {}
      if (completed) finish(job, 'completed')
      else finish(job, signal.aborted && signal.reason !== 'timeout' ? 'cancelled' : 'failed', failure || fault('DOWNLOAD_FAILED', 'The model download did not finish.'))
    }
  }
  function pump() {
    if (disposed) return
    for (const job of jobs.values()) {
      if (active >= maxActive) return
      if (job.state !== 'queued') continue
      job.state = 'downloading'; job.startedAt = now(); active++
      job.done = run(job).finally(() => { active--; pump() })
    }
  }
  function status({ jobId } = {}, { owner } = {}) {
    const key = ownerKey(owner)
    return jobId ? view(getJob(jobId, key)) : { jobs: [...jobs.values()].filter(job => job.owner === key).map(view) }
  }
  async function cancel({ jobId } = {}, { owner } = {}) {
    const job = getJob(jobId, ownerKey(owner))
    if (!terminal(job)) {
      job.controller.abort('cancelled')
      if (job.state === 'queued') finish(job, 'cancelled', fault('CANCELLED', 'The model download was cancelled.'))
      else await job.done
    }
    return view(job)
  }
  async function dispose() {
    disposed = true; previews.clear()
    for (const job of jobs.values()) if (!terminal(job)) {
      job.controller.abort('disposed')
      if (job.state === 'queued') finish(job, 'cancelled', fault('CANCELLED', 'The model download was cancelled.'))
    }
    await Promise.all([...jobs.values()].map(job => job.done).filter(Boolean))
  }
  return { preview, start, status, cancel, dispose }
}

module.exports = { createModelDownloadManager, MODEL_SUBDIRS, LIMITS }
