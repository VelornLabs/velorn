'use strict'

const nativeFs = require('node:fs')
const fsPromises = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const https = require('node:https')
const dns = require('node:dns/promises')
const { randomUUID, createHash } = require('node:crypto')
const { isPublicAddress } = require('./agentResearchWeb.cjs')

// LM Studio documents importing GGUFs by publisher/repository/file layout:
// https://lmstudio.ai/docs/app/advanced/import-model . Its official lms CLI
// resolves settings.json/downloadsFolder in src/subcommands/importCmd.ts and
// findLMStudioHome. We require that saved location instead of guessing a root.
// REST download currently has no documented cancellation endpoint. This owned
// transfer can actually stop; no lms/daemon download or arbitrary command runs.
// This boundary protects against untrusted model arguments, remote responses,
// and incidental filesystem replacement, not a hostile process as the same OS
// user. Node has no portable descriptor-relative filesystem transaction API.
const LIMITS = Object.freeze({ plans: 32, jobs: 32, planMs: 5 * 60 * 1000, metadataMs: 20000,
  downloadMs: 60 * 60 * 1000, loadMs: 3 * 60 * 1000, maxBytes: 32 * 1024 ** 3,
  metadataBytes: 2 * 1024 ** 2, redirects: 5 })
// Native /api/v1/models reports max_context_length and each loaded instance's
// config.context_length; /load can echo load_config for a second cross-check.
// https://lmstudio.ai/docs/developer/rest/list
// https://lmstudio.ai/docs/developer/rest/load
// Request a useful agent window, not an extended-context/RoPE override or a
// promise of memory fit. Qwen3-8B documents 32,768 native tokens; other models
// are capped at their own reported maximum, never guessed from the file name.
// https://huggingface.co/Qwen/Qwen3-8B
const CONTEXT = Object.freeze({ targetTokens: 32768, maximumMetadataTokens: 1024 * 1024 })
const contextTokens = value => Number.isSafeInteger(value) && value > 0 && value <= CONTEXT.maximumMetadataTokens ? value : null
const ORIGIN = 'http://127.0.0.1:1234'
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fault = (code, message) => Object.assign(new Error(message), { code, safeLmSetup: true })
const identity = stat => `${stat.dev}:${stat.ino}`
const fingerprint = stat => `${identity(stat)}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
const terminal = job => !['downloading', 'loading'].includes(job.state)
const safeId = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\x00-\x1f\x7f]/.test(value)
function argsOnly(args, fields) {
  if (!object(args) || Object.keys(args).length !== fields.length || fields.some(key => !Object.hasOwn(args, key))) throw fault('INVALID_ARGUMENTS', 'Provide only the exact setup fields.')
}
function ownerKey(owner) {
  if (typeof owner !== 'string' || !owner || owner.length > 4096) throw fault('INVALID_OWNER', 'A current desktop setup session is required.')
  return owner
}
function normalizeModel(args) {
  argsOnly(args, ['repository', 'filename'])
  const segment = (value, maximum = 96) => typeof value === 'string' && value.length <= maximum && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
    && !value.includes('..') && !/[. ]$/.test(value) && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value)
  if (typeof args.repository !== 'string' || args.repository.length > 160 || args.repository.split('/').length !== 2 || !args.repository.split('/').every(value => segment(value))) throw fault('INVALID_REPOSITORY', 'Choose one public Hugging Face publisher/repository, not a URL or path.')
  if (!segment(args.filename, 180) || !/\.gguf$/i.test(args.filename) || /-\d{5}-of-\d{5}\.gguf$/i.test(args.filename)) throw fault('UNSUPPORTED_MODEL', 'Choose one complete root-level GGUF file. MLX folders, shards and arbitrary paths are not supported.')
  return { repository: args.repository, filename: args.filename }
}
function checkAbort(signal) {
  if (signal?.aborted) throw fault(signal.reason === 'timeout' ? 'TIMEOUT' : 'CANCELLED', signal.reason === 'timeout' ? 'The LM Studio setup operation timed out.' : 'The LM Studio setup operation was cancelled.')
}
function abortable(promise, signal) {
  checkAbort(signal)
  return new Promise((resolve, reject) => {
    const abort = () => { try { checkAbort(signal) } catch (error) { reject(error) } }
    signal?.addEventListener('abort', abort, { once: true })
    Promise.resolve(promise).then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort))
  })
}
function header(response, name) {
  const value = response?.headers?.get ? response.headers.get(name) : response?.headers?.[name]
  return typeof value === 'string' && value.length <= 16384 && !/[\r\n\x00]/.test(value) ? value : null
}
async function closeResponse(response) {
  try {
    if (typeof response?.body?.destroy === 'function') response.body.destroy()
    else if (typeof response?.body?.cancel === 'function' && !response.body.locked) await response.body.cancel()
  } catch {}
}
function allowedDownloadUrl(value, initial) {
  let url
  try { url = new URL(value) } catch { return false }
  if (typeof value !== 'string' || value.length > 16384 || /[\x00-\x20\x7f\\]/.test(value)
    || url.protocol !== 'https:' || url.port || url.username || url.password || url.hash) return false
  if (value === initial) return true
  return ['cdn-lfs.huggingface.co', 'cdn-lfs-us-1.hf.co', 'cdn-lfs-eu-1.hf.co', 'cas-bridge.xethub.hf.co', 'us.aws.cdn.hf.co'].includes(url.hostname)
    && url.pathname.length > 1
}
// One hop, pinned public DNS/TLS, no ambient proxy, account, cookie or headers.
// Signed HF CDN query strings are accepted only after a reviewed HF redirect;
// they never become public results or native error messages.
async function publicFetch(value, { signal }) {
  const url = new URL(value)
  const addresses = await abortable(dns.lookup(url.hostname, { all: true, verbatim: true }), signal)
  if (!Array.isArray(addresses) || !addresses.length || addresses.length > 32 || addresses.some(row => !isPublicAddress(row.address))) throw fault('BLOCKED_SOURCE', 'The model source did not resolve to a public address.')
  const selected = addresses[0]
  return abortable(new Promise((resolve, reject) => {
    let request, response
    const abort = () => { response?.destroy(); request?.destroy(); reject(fault('CANCELLED', 'The model request was cancelled.')) }
    const cleanup = () => signal?.removeEventListener('abort', abort)
    signal?.addEventListener('abort', abort, { once: true })
    request = https.request({ hostname: url.hostname, port: 443, method: 'GET', path: `${url.pathname}${url.search}`,
      servername: url.hostname, rejectUnauthorized: true, agent: false, family: selected.family, autoSelectFamily: false,
      maxHeaderSize: 32768, lookup: (_name, options, callback) => typeof options === 'function'
        ? options(null, selected.address, selected.family) : options?.all ? callback(null, [selected]) : callback(null, selected.address, selected.family),
      headers: { Accept: '*/*', 'Accept-Encoding': 'identity', 'User-Agent': 'Velorn-LM-Setup/1.0' },
    }, incoming => {
      response = incoming
      if (incoming.socket?.remoteAddress?.replace(/^::ffff:/, '') !== selected.address.replace(/^::ffff:/, '')) {
        incoming.destroy(); cleanup(); reject(fault('BLOCKED_SOURCE', 'The model source connection changed.')); return
      }
      incoming.on('error', () => {}); incoming.once('close', cleanup)
      if (signal?.aborted) { abort(); return }
      resolve({ status: incoming.statusCode, headers: incoming.headers, body: incoming, url: url.href })
    })
    request.once('error', () => { cleanup(); reject(fault('NETWORK_ERROR', 'The public model source could not be reached.')) })
    if (signal?.aborted) abort(); else request.end()
  }), signal)
}
async function readJson(response, signal, cap = LIMITS.metadataBytes) {
  if (!response?.body?.[Symbol.asyncIterator]) throw fault('INVALID_RESPONSE', 'The setup service returned an unsupported response.')
  const chunks = []; let bytes = 0
  const iterator = response.body[Symbol.asyncIterator]()
  try {
    for (;;) {
      const { value, done } = await abortable(iterator.next(), signal)
      if (done) break
      bytes += value.byteLength
      if (bytes > cap) throw fault('INVALID_RESPONSE', 'The setup service response exceeded its size limit.')
      chunks.push(Buffer.from(value))
    }
    let result
    try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw fault('INVALID_RESPONSE', 'The setup service returned invalid metadata.') }
    if (!object(result)) throw fault('INVALID_RESPONSE', 'The setup service returned invalid metadata.')
    return result
  } finally { await closeResponse(response) }
}

function createLmStudioModelSetup({ confirm, assertCanStart = async () => {}, assertCanCommit = () => {}, fs = fsPromises,
  fetchPublic = publicFetch, fetchLocal = globalThis.fetch, getHomePath = os.homedir,
  getLmStudioHome, runtime, now = Date.now, totalmem = os.totalmem,
  planMs = LIMITS.planMs, metadataMs = LIMITS.metadataMs, downloadMs = LIMITS.downloadMs,
  loadMs = LIMITS.loadMs } = {}) {
  runtime ||= require('./lmStudioSetupRuntime.cjs').createLmStudioSetupRuntime({ getHomePath })
  const plans = new Map(), jobs = new Map(), operations = new Map(), invalidOwners = new Set()
  let disposed = false, actionBusy = false
  planMs = Math.min(LIMITS.planMs, Math.max(1, planMs)); metadataMs = Math.min(LIMITS.metadataMs, Math.max(1, metadataMs))
  downloadMs = Math.min(LIMITS.downloadMs, Math.max(1, downloadMs)); loadMs = Math.min(LIMITS.loadMs, Math.max(1, loadMs))
  const safeError = error => error?.safeLmSetup ? { code: error.code, message: error.message }
    : error?.code === 'LM_STUDIO_RUNTIME_UNAVAILABLE' ? { code: 'LM_STUDIO_RUNTIME_UNAVAILABLE', message: 'LM Studio’s local helper could not verify this model or start its server. Open LM Studio and check its lms helper and server before retrying.' }
      : { code: 'LM_SETUP_FAILED', message: 'LM Studio setup could not be completed. Check its local app and review the setup again.' }
  const api = fn => async (...args) => { try { return await fn(...args) } catch (error) { const e = safeError(error); return { success: false, code: e.code, error: e.message } } }
  function current(owner) {
    ownerKey(owner)
    if (disposed || invalidOwners.has(owner)) throw fault('SESSION_CLOSED', 'This desktop setup session has ended.')
  }
  async function live(owner, action) { current(owner); await assertCanStart({ owner, action }); current(owner) }
  function commitGuard(owner, action) {
    current(owner)
    const result = assertCanCommit({ owner, action })
    if (typeof result?.then === 'function') {
      Promise.resolve(result).catch(() => {})
      throw fault('INVALID_COMMIT_GUARD', 'The native setup guard could not confirm this action synchronously.')
    }
    current(owner)
  }
  function timed(owner, timeout) {
    current(owner)
    const controller = new AbortController(), timer = setTimeout(() => controller.abort('timeout'), timeout)
    timer.unref?.(); operations.set(controller, owner)
    return { controller, signal: controller.signal, close() { clearTimeout(timer); operations.delete(controller) } }
  }
  async function exists(file) { try { return await fs.lstat(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
  async function directory(file) {
    const stat = await fs.lstat(file)
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(file) !== file) throw fault('UNSAFE_DESTINATION', 'LM Studio model folders must be real directories, not symbolic links.')
    return { path: file, id: identity(stat) }
  }
  async function snapshot(model) {
    const home = await getHomePath(), lmHome = getLmStudioHome ? await getLmStudioHome() : path.join(home, '.lmstudio')
    if (typeof home !== 'string' || !path.isAbsolute(home) || typeof lmHome !== 'string' || !path.isAbsolute(lmHome)) throw fault('LM_NOT_CONFIGURED', 'Open LM Studio once and choose its model download folder first.')
    const appRoot = await directory(path.resolve(lmHome)), settingsFile = path.join(appRoot.path, 'settings.json')
    const settingsStat = await fs.lstat(settingsFile)
    if (!settingsStat.isFile() || settingsStat.isSymbolicLink() || settingsStat.size > 1024 ** 2) throw fault('LM_NOT_CONFIGURED', 'LM Studio settings could not be read safely. Open its settings and check the model folder.')
    const handle = await fs.open(settingsFile, nativeFs.constants.O_RDONLY | (nativeFs.constants.O_NOFOLLOW || 0))
    let settings
    try {
      if (fingerprint(await handle.stat()) !== fingerprint(settingsStat)) throw fault('DESTINATION_CHANGED', 'LM Studio settings changed during inspection.')
      const value = await handle.readFile('utf8')
      if (Buffer.byteLength(value) > 1024 ** 2 || fingerprint(await handle.stat()) !== fingerprint(settingsStat)) throw fault('DESTINATION_CHANGED', 'LM Studio settings changed during inspection.')
      try { settings = JSON.parse(value) } catch { throw fault('LM_NOT_CONFIGURED', 'LM Studio settings could not be read. Check the model download folder in LM Studio.') }
    } finally { await handle.close() }
    const configured = settings?.downloadsFolder
    if (typeof configured !== 'string' || configured.includes('\0') || !path.isAbsolute(configured)
      || path.resolve(configured) === path.parse(configured).root || path.resolve(configured) === path.resolve(home)) throw fault('LM_NOT_CONFIGURED', 'LM Studio must have an existing, dedicated model download folder.')
    const root = await directory(path.resolve(configured)), parts = model.repository.split('/')
    const dirs = []
    let at = root.path
    for (const part of parts) {
      at = path.join(at, part)
      const stat = await exists(at)
      dirs.push(stat ? await directory(at) : null)
    }
    return { appRoot, root, dirs }
  }
  async function sameRoot(job) {
    const actual = await snapshot(job.model)
    if (JSON.stringify(actual) !== JSON.stringify(job.snapshot)) throw fault('DESTINATION_CHANGED', 'LM Studio model storage changed. Review a new setup plan before continuing.')
    return actual
  }
  function destination(item) { return path.join(item.snapshot.root.path, ...item.model.repository.split('/'), item.model.filename) }
  async function availableDestination(item) {
    const target = destination(item)
    if (await exists(target)) throw fault('DESTINATION_EXISTS', 'That model file already exists. It will not be overwritten or downloaded again.')
    if (item.snapshot.dirs[1]) {
      const names = await fs.readdir(item.snapshot.dirs[1].path)
      if (names.some(value => value.replace(/[. ]+$/, '').toLowerCase() === item.model.filename.toLowerCase())) throw fault('DESTINATION_EXISTS', 'A model file with that name already exists. It will not be overwritten.')
    }
  }
  async function space(item) {
    if (typeof fs.statfs !== 'function') throw fault('DISK_UNKNOWN', 'Available model storage could not be checked.')
    const stat = await fs.statfs(item.snapshot.root.path), free = Number(stat.bavail) * Number(stat.bsize)
    if (!Number.isFinite(free)) throw fault('DISK_UNKNOWN', 'Available model storage could not be checked.')
    if (free < item.model.bytes + 64 * 1024 ** 2) throw fault('INSUFFICIENT_SPACE', 'There is not enough free space for this exact model download.')
  }
  async function metadata(model, signal) {
    const prefix = `https://huggingface.co/api/models/${model.repository}`
    async function info(url) {
      const response = await abortable(fetchPublic(url, { method: 'GET', redirect: 'manual', credentials: 'omit', signal }), signal)
      if (response.url && response.url !== url || response.status !== 200) { await closeResponse(response); throw fault('MODEL_METADATA_UNAVAILABLE', 'Public model metadata is unavailable. Gated, private or renamed repositories are not supported.') }
      return readJson(response, signal)
    }
    const latest = await info(`${prefix}?blobs=true`)
    if (!/^[a-f0-9]{40}$/.test(latest.sha)) throw fault('INVALID_METADATA', 'An immutable model revision could not be verified.')
    const data = await info(`${prefix}/revision/${latest.sha}?blobs=true`)
    if (data.sha !== latest.sha || data.id !== model.repository || data.private !== false || data.gated !== false
      || !Array.isArray(data.siblings) || data.siblings.length > 10000) throw fault('INVALID_METADATA', 'The selected repository is not a verified public model revision.')
    const matches = data.siblings.filter(row => row.rfilename === model.filename)
    if (matches.length !== 1) throw fault('MODEL_NOT_FOUND', 'That exact GGUF file is not present. Choose the file and quantization explicitly.')
    const file = matches[0], bytes = file.lfs?.size, sha256 = file.lfs?.sha256
    if (!Number.isSafeInteger(bytes) || bytes < 24 || bytes > LIMITS.maxBytes || file.size !== bytes || !/^[a-f0-9]{64}$/.test(sha256)) throw fault('INVALID_METADATA', 'The exact file size and SHA-256 must be available, and the model must be at most 32 GiB.')
    const licenseName = data.cardData?.license
    if (typeof licenseName !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9 ._+-]{0,95}$/.test(licenseName) || /^(?:unknown|none|other)$/i.test(licenseName)) throw fault('LICENSE_UNKNOWN', 'The model repository has no clear license metadata. Review its license manually before choosing a model.')
    const licenseFile = ['LICENSE', 'LICENSE.txt', 'LICENSE.md'].find(name => data.siblings.some(row => row.rfilename === name)) || 'README.md'
    return { ...model, revision: data.sha, bytes, sha256,
      modelName: model.filename.replace(/\.gguf$/i, ''), sourceUrl: `https://huggingface.co/${model.repository}/resolve/${data.sha}/${model.filename}`,
      license: { name: licenseName, url: `https://huggingface.co/${model.repository}/blob/${data.sha}/${licenseFile}` } }
  }
  async function plan(args, owner) {
    const model = normalizeModel(args); await live(owner, 'plan')
    const operation = timed(owner, metadataMs)
    try {
      const data = await metadata(model, operation.signal)
      const record = { owner, model: data, snapshot: await snapshot(data) }
      await space(record); await live(owner, 'plan'); checkAbort(operation.signal)
      let canDownload = true
      try { await availableDestination(record) } catch (error) { if (error.code !== 'DESTINATION_EXISTS') throw error; canDownload = false }
      const warnings = ["Model metadata and licensing come from its publisher. Loading is separate; no prompt is sent and your current agent remains unchanged."]
      if (!canDownload) warnings.push('This exact destination already exists. Use the existing model in LM Studio; Velorn will not overwrite it.')
      const memory = Number(totalmem())
      if (!Number.isFinite(memory) || data.bytes * 1.5 > memory) warnings.push('This model may exceed available memory when loaded. File size is not a memory-fit guarantee.')
      const planId = randomUUID(), expiresAt = now() + planMs
      const view = { success: true, planId, integration: 'lmstudio', modelName: data.modelName,
        repository: data.repository, revision: data.revision, filename: data.filename, sourceUrl: data.sourceUrl,
        license: data.license, bytes: data.bytes, sha256: data.sha256, destination: `LM Studio models/${data.repository}/${data.filename}`,
        canDownload, warnings, expiresAt, contextTargetTokens: CONTEXT.targetTokens, contextPolicy: 'model-capped' }
      for (const [id, item] of plans) if (item.view.expiresAt <= now()) plans.delete(id)
      while (plans.size >= LIMITS.plans) plans.delete(plans.keys().next().value)
      plans.set(planId, { ...record, view }); return view
    } finally { operation.close() }
  }
  function jobView(job) {
    return { success: true, jobId: job.id, integration: 'lmstudio', modelName: job.model.modelName,
      repository: job.model.repository, filename: job.model.filename, state: job.state,
      bytesReceived: job.bytes, totalBytes: job.model.bytes, canLoad: job.state === 'completed' && !job.invalidated && !job.uncertain,
      contextTargetTokens: CONTEXT.targetTokens, requestedContextTokens: job.requestedContextTokens ?? null,
      modelMaxContextTokens: job.modelMaxContextTokens ?? null, effectiveContextTokens: job.effectiveContextTokens ?? null,
      contextVerified: job.state === 'ready' && job.contextVerified === true,
      connectionVerified: job.state === 'ready', ...(job.error ? { error: job.error } : {}), ...(job.warning ? { warning: job.warning } : {}) }
  }
  function find(args, owner) {
    current(owner); argsOnly(args, ['jobId'])
    const job = jobs.get(args.jobId)
    if (!job || job.owner !== owner) throw fault('UNKNOWN_JOB', 'That model setup job does not belong to this desktop session.')
    return job
  }
  function review(item, action) {
    return { owner: item.owner, action, ...(item.view ? { plan: item.view } : { job: jobView(item) }),
      modelName: item.model.modelName, repository: item.model.repository, revision: item.model.revision,
      filename: item.model.filename, sourceUrl: item.model.sourceUrl, license: item.model.license,
      bytes: item.model.bytes, destination: destination(item), contextTargetTokens: CONTEXT.targetTokens, contextPolicy: 'model-capped' }
  }
  async function createDirs(job) {
    await sameRoot(job)
    let at = job.snapshot.root.path
    for (let index = 0; index < 2; index++) {
      at = path.join(at, job.model.repository.split('/')[index])
      if (!job.snapshot.dirs[index]) {
        await live(job.owner, 'download-background'); checkAbort(job.operation.signal)
        await fs.mkdir(at, { recursive: false, mode: 0o700 })
        job.snapshot.dirs[index] = await directory(at)
      }
      await sameRoot(job)
    }
  }
  async function cleanupPartial(job) {
    if (!job.partial || !job.fileId) return
    const stat = await exists(job.partial)
    if (stat?.isFile() && !stat.isSymbolicLink() && identity(stat) === job.fileId) await fs.unlink(job.partial)
  }
  async function modelResponse(job) {
    let url = job.model.sourceUrl
    for (let hop = 0; ; hop++) {
      if (!allowedDownloadUrl(url, job.model.sourceUrl)) throw fault('BLOCKED_SOURCE', 'The model download redirected outside the reviewed Hugging Face delivery hosts.')
      const response = await abortable(fetchPublic(url, { method: 'GET', redirect: 'manual', credentials: 'omit', signal: job.operation.signal }), job.operation.signal)
      if (response.url && response.url !== url) { await closeResponse(response); throw fault('BLOCKED_SOURCE', 'The download client followed an unreviewed redirect.') }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = header(response, 'location'); await closeResponse(response)
        if (!location || hop >= LIMITS.redirects) throw fault('BLOCKED_SOURCE', 'The model source returned too many or invalid redirects.')
        try { url = new URL(location, url).href } catch { throw fault('BLOCKED_SOURCE', 'The model source returned an invalid redirect.') }
        continue
      }
      const encoding = header(response, 'content-encoding'), length = header(response, 'content-length')
      if (response.status !== 200 || !length || !/^\d+$/.test(length) || Number(length) !== job.model.bytes
        || encoding && encoding !== 'identity' || /(?:text\/|json|html|xml)/i.test(header(response, 'content-type') || '')) {
        await closeResponse(response); throw fault('DOWNLOAD_CHANGED', 'The model response does not match the approved file size or binary content.')
      }
      return response
    }
  }
  async function transfer(job) {
    let handle, response, committed = false, outcome = 'failed'
    try {
      await live(job.owner, 'download-background'); checkAbort(job.operation.signal)
      await createDirs(job); await availableDestination(job); await space(job)
      job.partial = path.join(job.snapshot.dirs[1].path, `.velorn-${job.id}.partial`)
      handle = await fs.open(job.partial, nativeFs.constants.O_RDWR | nativeFs.constants.O_CREAT | nativeFs.constants.O_EXCL | (nativeFs.constants.O_NOFOLLOW || 0), 0o600)
      job.fileId = identity(await handle.stat())
      response = await modelResponse(job)
      if (!response.body?.[Symbol.asyncIterator]) throw fault('INVALID_RESPONSE', 'The model transfer is not streamable.')
      const iterator = response.body[Symbol.asyncIterator](), hash = createHash('sha256')
      for (;;) {
        const chunk = await abortable(iterator.next(), job.operation.signal)
        if (chunk.done) break
        await live(job.owner, 'download-background'); checkAbort(job.operation.signal)
        if (chunk.value.byteLength > job.model.bytes - job.bytes) throw fault('DOWNLOAD_CHANGED', 'The model exceeded its approved byte count.')
        const value = Buffer.from(chunk.value)
        let written = 0
        while (written < value.length) { const result = await handle.write(value, written, value.length - written, job.bytes + written); if (!result.bytesWritten) throw fault('DISK_WRITE_FAILED', 'The model transfer could not write to storage.'); written += result.bytesWritten }
        hash.update(value); job.bytes += value.length
      }
      if (job.bytes !== job.model.bytes || hash.digest('hex') !== job.model.sha256) throw fault('HASH_MISMATCH', 'The downloaded model does not match the approved SHA-256 and byte count.')
      const magic = Buffer.alloc(24); await handle.read(magic, 0, 24, 0)
      if (magic.toString('ascii', 0, 4) !== 'GGUF' || ![2, 3].includes(magic.readUInt32LE(4))) throw fault('INVALID_GGUF', 'The model file is not a supported GGUF.')
      await handle.sync(); await handle.close(); handle = null
      await live(job.owner, 'download-background'); checkAbort(job.operation.signal)
      await sameRoot(job); await availableDestination(job)
      const finalPartial = await fs.lstat(job.partial)
      if (!finalPartial.isFile() || finalPartial.isSymbolicLink() || identity(finalPartial) !== job.fileId || finalPartial.size !== job.model.bytes) throw fault('MODEL_CHANGED', 'The temporary model changed before it could be installed.')
      checkAbort(job.operation.signal)
      // link is atomic and fails if ANY destination already exists.
      commitGuard(job.owner, 'download-commit')
      await fs.link(job.partial, destination(job)); committed = true
      outcome = 'completed'
    } catch (error) {
      if (committed) {
        outcome = 'completed'
      } else {
        outcome = job.operation.signal.aborted && job.operation.signal.reason !== 'timeout' ? 'cancelled' : 'failed'
        job.error = safeError(job.operation.signal.aborted ? (() => { try { checkAbort(job.operation.signal) } catch (e) { return e } })() : error)
      }
    } finally {
      await closeResponse(response)
      if (handle) await handle.close().catch(() => {})
      await cleanupPartial(job).catch(() => {
        job.warning = committed
          ? 'The model was saved, but temporary-file cleanup could not finish. Existing files were left untouched.'
          : 'The transfer stopped, but its temporary file could not be removed. Inspect LM Studio model storage before retrying.'
      })
      job.operation.close()
      // Terminal state releases the single-active slot and enables Load. Do
      // not publish it while the owned handle/partial is still being cleaned.
      // A committed model remains completed even if cleanup fails or a late
      // cancellation arrives: cancellation cannot roll back that saved file.
      job.state = outcome
    }
  }
  async function download(args, owner) {
    argsOnly(args, ['planId']); await live(owner, 'download')
    const item = plans.get(args.planId)
    if (!item || item.owner !== owner || item.view.expiresAt <= now()) throw fault('PLAN_EXPIRED', 'Review a fresh model plan for this desktop session.')
    if (!item.view.canDownload) throw fault('DESTINATION_EXISTS', 'This model already exists. It will not be downloaded again.')
    if (actionBusy || [...jobs.values()].some(job => !terminal(job))) throw fault('BUSY', 'Wait for the current model setup action to finish.')
    actionBusy = true
    try {
      await sameRoot(item); await availableDestination(item); await space(item)
      const approved = await confirm?.(review(item, 'download'))
      await live(owner, 'download')
      if (approved !== true) throw fault('DECLINED', 'The model download was not approved.')
      if (item.view.expiresAt <= now() || plans.get(args.planId) !== item) throw fault('PLAN_EXPIRED', 'The model plan expired. Review it again before downloading.')
      await sameRoot(item); await availableDestination(item); await space(item); await live(owner, 'download')
      plans.delete(args.planId)
      while (jobs.size >= LIMITS.jobs) { const old = [...jobs.values()].find(terminal); if (!old) throw fault('BUSY', 'The model setup job limit was reached.'); jobs.delete(old.id) }
      const job = { id: randomUUID(), owner, model: item.model, snapshot: item.snapshot, state: 'downloading', bytes: 0, operation: timed(owner, downloadMs) }
      jobs.set(job.id, job); job.done = transfer(job); return jobView(job)
    } finally { actionBusy = false }
  }
  async function status(args, owner) { const job = find(args, owner); await live(owner, 'status'); return jobView(job) }
  async function cancel(args, owner) {
    const job = find(args, owner); await live(owner, 'cancel')
    if (job.state === 'loading') throw fault('LOAD_IN_PROGRESS', 'LM Studio has no verified cancellation for an accepted model load. Check LM Studio; Velorn will not claim it was unloaded.')
    if (job.state === 'downloading') { job.operation.controller.abort('cancelled'); await job.done }
    return jobView(job)
  }
  async function verifyFile(job, signal) {
    await sameRoot(job)
    const file = destination(job), stat = await fs.lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || identity(stat) !== job.fileId || stat.size !== job.model.bytes) throw fault('MODEL_CHANGED', 'The saved model changed. It will not be loaded.')
    const handle = await fs.open(file, nativeFs.constants.O_RDONLY | (nativeFs.constants.O_NOFOLLOW || 0))
    try {
      if (fingerprint(await handle.stat()) !== fingerprint(stat)) throw fault('MODEL_CHANGED', 'The saved model changed before verification.')
      const buffer = Buffer.alloc(1024 ** 2), hash = createHash('sha256'); let position = 0
      for (;;) {
        await live(job.owner, 'load-verification'); checkAbort(signal)
        const read = await handle.read(buffer, 0, buffer.length, position)
        if (!read.bytesRead) break
        position += read.bytesRead; hash.update(buffer.subarray(0, read.bytesRead))
        if (position > job.model.bytes) throw fault('MODEL_CHANGED', 'The saved model changed during verification.')
      }
      if (position !== job.model.bytes || hash.digest('hex') !== job.model.sha256 || fingerprint(await handle.stat()) !== fingerprint(stat)) throw fault('MODEL_CHANGED', 'The saved model no longer matches its approved checksum.')
      await sameRoot(job)
      if (fingerprint(await fs.lstat(file)) !== fingerprint(stat)) throw fault('MODEL_CHANGED', 'The saved model changed during verification.')
    } finally { await handle.close() }
  }
  async function localRequest(route, signal, body) {
    let response
    try { response = await abortable(fetchLocal(`${ORIGIN}/api/v1/models${route}`, { method: body ? 'POST' : 'GET', redirect: 'error', signal,
      headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined }), signal) }
    catch (error) { checkAbort(signal); if (error.safeLmSetup) throw error; throw fault('LM_OFFLINE', 'LM Studio is not responding on its local port 1234.') }
    if ([401, 403].includes(response.status)) { await closeResponse(response); throw fault('LM_AUTH_REQUIRED', 'LM Studio requires authentication. Velorn will not disable authentication or bypass it; configure a supported connection in LM Studio.') }
    if (response.status !== 200) { await closeResponse(response); throw fault('LM_API_UNAVAILABLE', 'LM Studio could not confirm model management. Update or inspect LM Studio before retrying.') }
    if (response.url && response.url !== `${ORIGIN}/api/v1/models${route}`) { await closeResponse(response); throw fault('LM_API_UNAVAILABLE', 'The local model-management endpoint changed.') }
    return readJson(response, signal)
  }
  async function localModels(signal) {
    const body = await localRequest('', signal)
    if (!Array.isArray(body.models) || body.models.length > 2048) throw fault('LM_API_UNAVAILABLE', 'LM Studio returned an invalid model catalog.')
    return body.models.filter(row => object(row) && row.type === 'llm' && safeId(row.key) && Number.isSafeInteger(row.size_bytes)
      && Array.isArray(row.loaded_instances) && row.loaded_instances.every(instance => object(instance) && safeId(instance.id)))
  }
  async function performLoad(job) {
    const signal = job.operation.signal
    try {
      await live(job.owner, 'load-background'); checkAbort(signal); await sameRoot(job)
      let rows
      try { rows = await localModels(signal) } catch (error) {
        if (error.code !== 'LM_OFFLINE' || typeof runtime?.startServer !== 'function') throw error
        await live(job.owner, 'load-background'); checkAbort(signal)
        await abortable(runtime.startServer({ signal, beforeStart: () => commitGuard(job.owner, 'load-commit') }), signal)
        rows = await localModels(signal)
      }
      if (typeof runtime?.listDownloadedModels !== 'function') throw fault('LM_IDENTITY_UNAVAILABLE', 'LM Studio cannot identify the exact downloaded file. Check its model list manually.')
      const downloaded = await abortable(runtime.listDownloadedModels({ signal }), signal)
      const relative = `${job.model.repository}/${job.model.filename}`
      const matches = Array.isArray(downloaded) && downloaded.length <= 2048 ? downloaded.filter(row => object(row)
        && row.type === 'llm' && row.sizeBytes === job.model.bytes && safeId(row.modelKey)
        && (row.path === relative || row.path === destination(job))) : []
      if (matches.length !== 1) throw fault('LM_IDENTITY_UNAVAILABLE', 'LM Studio has not uniquely indexed this exact file. Refresh its model list before loading; no model was selected by guess.')
      const modelKey = matches[0].modelKey
      const isGroup = row => Array.isArray(row.variants) && row.variants.length <= 64 && row.variants.every(safeId) && row.variants.includes(modelKey)
      const exact = rows.filter(row => row.key === modelKey && row.size_bytes === job.model.bytes || isGroup(row))
      if (exact.length !== 1) throw fault('LM_IDENTITY_UNAVAILABLE', 'LM Studio could not map this exact file to one local model. No model was loaded by guess.')
      job.modelMaxContextTokens = contextTokens(exact[0].max_context_length)
      if (job.modelMaxContextTokens === null) throw fault('LM_CONTEXT_UNAVAILABLE', 'LM Studio did not report a verifiable supported context limit. Check or update LM Studio before loading; no context size was guessed and no model load was requested.')
      job.requestedContextTokens = Math.min(CONTEXT.targetTokens, job.modelMaxContextTokens)
      // Catalog/CLI/startup can await for seconds. Verify AFTER their final
      // asynchronous authority check, immediately before the model handoff.
      await live(job.owner, 'load-background'); checkAbort(signal)
      await verifyFile(job, signal)
      let instanceId, echoedContextTokens = null, requestedNewLoad = false
      if (isGroup(exact[0]) && exact[0].loaded_instances.length) throw fault('LM_IDENTITY_UNAVAILABLE', 'A grouped model already has loaded instances. LM Studio does not identify which file each uses; inspect them before loading another variant.')
      if (exact[0].loaded_instances.length === 1) {
        const instance = exact[0].loaded_instances[0]
        job.effectiveContextTokens = contextTokens(instance.config?.context_length)
        if (job.effectiveContextTokens === null || job.effectiveContextTokens > job.modelMaxContextTokens) throw fault('LM_CONTEXT_UNAVAILABLE', 'The existing model instance has no verifiable loaded context. Inspect its context setting in LM Studio; Velorn left it loaded and unchanged.')
        if (job.effectiveContextTokens < job.requestedContextTokens) throw fault('LM_CONTEXT_TOO_SMALL', `The existing model is loaded with ${job.effectiveContextTokens.toLocaleString('en-US')} context tokens; setup targets ${job.requestedContextTokens.toLocaleString('en-US')}. Change its context in LM Studio when you are ready; Velorn did not reload or unload it.`)
        instanceId = instance.id
      }
      else if (exact[0].loaded_instances.length > 1) throw fault('LM_IDENTITY_UNAVAILABLE', 'Multiple instances of this model are already loaded. Select the intended instance in LM Studio.')
      else {
        checkAbort(signal)
        commitGuard(job.owner, 'load-commit')
        job.uncertain = true; requestedNewLoad = true
        const loaded = await localRequest('/load', signal, { model: modelKey, context_length: job.requestedContextTokens, echo_load_config: true })
        if (loaded.status !== 'loaded' || loaded.type !== 'llm' || !safeId(loaded.instance_id)) throw fault('LOAD_UNCONFIRMED', 'LM Studio did not confirm the model load. Inspect LM Studio before trying again.')
        if (Object.hasOwn(loaded, 'load_config')) {
          echoedContextTokens = contextTokens(loaded.load_config?.context_length)
          if (echoedContextTokens === null) throw fault('LM_CONTEXT_UNCONFIRMED', 'LM Studio returned an invalid loaded context. Inspect its context setting; Velorn will not automatically retry or unload the model.')
        }
        instanceId = loaded.instance_id
      }
      rows = await localModels(signal)
      const verified = rows.filter(row => (row.key === modelKey && row.size_bytes === job.model.bytes || isGroup(row))
        && row.loaded_instances.some(instance => instance.id === instanceId))
      if (verified.length !== 1 || rows.filter(row => row.loaded_instances.some(instance => instance.id === instanceId)).length !== 1) throw fault('LOAD_UNCONFIRMED', 'The loaded model instance could not be verified. Check LM Studio before retrying.')
      const instances = verified[0].loaded_instances.filter(instance => instance.id === instanceId)
      job.effectiveContextTokens = instances.length === 1 ? contextTokens(instances[0].config?.context_length) : null
      if (contextTokens(verified[0].max_context_length) !== job.modelMaxContextTokens || job.effectiveContextTokens === null
        || job.effectiveContextTokens < job.requestedContextTokens || job.effectiveContextTokens > job.modelMaxContextTokens
        || requestedNewLoad && job.effectiveContextTokens !== job.requestedContextTokens
        || echoedContextTokens !== null && echoedContextTokens !== job.effectiveContextTokens) {
        throw fault('LM_CONTEXT_UNCONFIRMED', 'LM Studio did not verify the requested context on the exact loaded instance. Inspect its context setting; Velorn will not automatically retry or unload the model.')
      }
      await live(job.owner, 'load-background'); checkAbort(signal)
      commitGuard(job.owner, 'load-commit')
      job.state = 'ready'; job.uncertain = false; job.contextVerified = true; delete job.error
      job.warning = 'LM Studio reports this exact model and its loaded context on local port 1234. Larger context uses more memory; this is not a memory-fit guarantee. No inference or tool-capability test was run; your current agent, model and chat are unchanged.'
    } catch (error) {
      job.state = 'completed'; job.contextVerified = false; job.error = safeError(error)
      if (['MODEL_CHANGED', 'DESTINATION_CHANGED', 'ENOENT', 'UNSAFE_DESTINATION'].includes(error?.code)) job.invalidated = true
      if (job.uncertain) job.warning = 'LM Studio may have accepted the load. Velorn will not automatically repeat or unload it; inspect LM Studio first.'
    } finally { job.operation.close() }
  }
  async function load(args, owner) {
    const job = find(args, owner); await live(owner, 'load')
    if (job.state !== 'completed' || job.invalidated || job.uncertain) throw fault('NOT_LOADABLE', 'Only a completed, verified model can be loaded; inspect uncertain loads in LM Studio.')
    if (actionBusy || [...jobs.values()].some(item => !terminal(item))) throw fault('BUSY', 'Another model setup action is running.')
    actionBusy = true
    try {
      await job.done; await sameRoot(job)
      const approved = await confirm?.(review(job, 'load'))
      await live(owner, 'load')
      if (approved !== true) throw fault('DECLINED', 'Loading this model was not approved.')
      await sameRoot(job); await live(owner, 'load')
      job.operation = timed(owner, loadMs); job.state = 'loading'; job.contextVerified = false
      job.requestedContextTokens = null; job.modelMaxContextTokens = null; job.effectiveContextTokens = null
      delete job.error; delete job.warning
      job.done = performLoad(job); return jobView(job)
    } finally { actionBusy = false }
  }
  async function cancelOwner(owner) {
    ownerKey(owner); invalidOwners.add(owner)
    for (const [id, value] of plans) if (value.owner === owner) plans.delete(id)
    for (const [controller, key] of operations) if (key === owner) controller.abort('owner-closed')
    await Promise.all([...jobs.values()].filter(job => job.owner === owner).map(job => job.done))
  }
  async function dispose() {
    disposed = true; plans.clear()
    for (const controller of operations.keys()) controller.abort('disposed')
    await Promise.all([...jobs.values()].map(job => job.done))
  }
  return { plan: api(plan), download: api(download), status: api(status), cancel: api(cancel), load: api(load), cancelOwner, dispose }
}

module.exports = { createLmStudioModelSetup, LIMITS, CONTEXT, normalizeModel, allowedDownloadUrl }
