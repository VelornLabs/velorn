'use strict'

const nativeFs = require('node:fs')
const fsPromises = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const https = require('node:https')
const dns = require('node:dns/promises')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { randomUUID, createHash } = require('node:crypto')
const { isPublicAddress } = require('./agentResearchWeb.cjs')
const executeFile = promisify(execFile)

const LIMITS = Object.freeze({ plans: 32, jobs: 32, planMs: 5 * 60 * 1000, downloadMs: 20 * 60 * 1000,
  metadataMs: 12000, maxBytes: 2 * 1024 ** 3, redirects: 4 })
const CATALOG = Object.freeze({
  comfyui: Object.freeze({ name: 'Comfy Desktop', filename: 'Comfy-Desktop', darwin: 22, memoryGiB: 8,
    source: 'https://dl.todesktop.com/241130tqe9q3y/mac/dmg/arm64',
    guide: 'https://docs.comfy.org/installation/desktop/overview',
    apps: ['Comfy Desktop.app', 'ComfyUI.app'],
    steps: ['Download the official Comfy Desktop installer after reviewing the source, size and destination.',
      'Open the downloaded DMG after a separate confirmation, drag Comfy Desktop into Applications, then launch it yourself.',
      'Create a local Standalone instance, choose its storage location and review the dependency downloads. Do not choose Cloud for local setup.',
      'Launch that instance, return to Velorn and check its local connection. Choose its exact port if more than one server is found.',
      'Review any workflow, custom nodes and model downloads separately before generation.'],
    storage: 'Each ComfyUI instance needs at least 4.85 GB plus additional space for models and outputs. The installer download is not the complete installation.',
  }),
  lmstudio: Object.freeze({ name: 'LM Studio', filename: 'LM-Studio', darwin: 23, memoryGiB: 16,
    source: 'https://lmstudio.ai/download/latest/darwin/arm64', guide: 'https://lmstudio.ai/download',
    apps: ['LM Studio.app'],
    steps: ['Download the ordinary LM Studio app, not Bionic or llmster, after reviewing the source, size and destination.',
      'Open the downloaded DMG after a separate confirmation, drag LM Studio into Applications, then launch it yourself.',
      'In Discover, review a suitable chat model, its license, download size and storage location before choosing to download it. Load that model explicitly.',
      'In Developer, start the local server on port 1234. Keep network sharing off; do not disable required authentication to work around a connection problem.',
      'Return to Velorn and check setup, then explicitly choose LM Studio and its model in Agent settings.'],
    storage: 'Models are separate downloads and may use many GB of disk space and memory. Review the exact model, license, size and destination first.',
  }),
})
const failure = (code, error) => ({ success: false, code, error })
const fault = (code, message) => Object.assign(new Error(message), { code, toolSetupFault: true })
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const identity = stat => `${stat.dev}:${stat.ino}`
const terminal = job => ['completed', 'failed', 'cancelled'].includes(job.state)
const checkedOwner = owner => {
  if (typeof owner !== 'string' || !owner || owner.length > 4096) throw fault('INVALID_OWNER', 'A current desktop setup session is required.')
  return owner
}
function argsOnly(args, key) {
  if (!object(args) || Object.keys(args).length !== 1 || typeof args[key] !== 'string' || !args[key] || args[key].length > 100) {
    throw fault('INVALID_REQUEST', `Provide only ${key} for this setup action.`)
  }
  return args[key]
}
function allowedUrl(integration, value) {
  if (!Object.hasOwn(CATALOG, integration)) return false
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\x7f\\]/.test(value)) return false
  let url
  try { url = new URL(value) } catch { return false }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash) return false
  if (integration === 'comfyui') return url.href === CATALOG.comfyui.source
  return url.href === CATALOG.lmstudio.source || url.origin === 'https://installers.lmstudio.ai'
    && /^\/darwin\/arm64\/\d+\.\d+\.\d+-\d+\/LM-Studio-\d+\.\d+\.\d+-\d+-arm64\.dmg$/.test(url.pathname)
}
const abortFault = signal => signal?.reason === 'timeout'
  ? fault('TIMEOUT', 'The setup operation exceeded its time limit.') : fault('CANCELLED', 'The setup operation was cancelled.')
function checkAbort(signal) { if (signal?.aborted) throw abortFault(signal) }
function abortable(promise, signal) {
  checkAbort(signal)
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortFault(signal))
    signal?.addEventListener('abort', abort, { once: true })
    Promise.resolve(promise).then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort))
  })
}
function header(response, name) {
  const value = response?.headers?.get ? response.headers.get(name) : response?.headers?.[name]
  return typeof value === 'string' && value.length < 8192 && !/[\r\n\x00]/.test(value) ? value : null
}
async function closeResponse(response) {
  try {
    if (typeof response?.body?.destroy === 'function') response.body.destroy()
    else if (typeof response?.body?.cancel === 'function' && !response.body.locked) await response.body.cancel()
    else if (typeof response?.body?.return === 'function') await response.body.return()
  } catch {}
}

// Single hop only, without cookies/proxies/credentials. Pin a reviewed public
// DNS address into TLS, then let the catalog layer validate every redirect.
async function publicFetch(urlString, { method, signal }) {
  const url = new URL(urlString)
  const addresses = await abortable(dns.lookup(url.hostname, { all: true, verbatim: true }), signal)
  if (!Array.isArray(addresses) || !addresses.length || addresses.length > 32 || addresses.some(value => !isPublicAddress(value.address))) {
    throw fault('BLOCKED_SOURCE', 'The official download host did not resolve to a public address.')
  }
  const selected = addresses[0]
  return abortable(new Promise((resolve, reject) => {
    let request, response
    const abort = () => { response?.destroy(); request?.destroy(); reject(abortFault(signal)) }
    const cleanup = () => signal?.removeEventListener('abort', abort)
    signal?.addEventListener('abort', abort, { once: true })
    request = https.request({ protocol: 'https:', hostname: url.hostname, port: 443, method, path: url.pathname,
      servername: url.hostname, rejectUnauthorized: true, agent: false, family: selected.family, autoSelectFamily: false,
      maxHeaderSize: 16384, lookup: (_name, options, callback) => typeof options === 'function'
        ? options(null, selected.address, selected.family) : options?.all ? callback(null, [selected]) : callback(null, selected.address, selected.family),
      headers: { Accept: 'application/octet-stream', 'Accept-Encoding': 'identity', 'User-Agent': 'Velorn-Optional-Setup/1.0' },
    }, incoming => {
      response = incoming
      const connected = incoming.socket?.remoteAddress?.replace(/^::ffff:/, '')
      if (connected !== selected.address.replace(/^::ffff:/, '')) {
        incoming.destroy(); cleanup(); reject(fault('BLOCKED_SOURCE', 'The download socket did not connect to the approved address.')); return
      }
      incoming.on('error', () => {})
      incoming.once('close', cleanup)
      if (signal?.aborted) { abort(); return }
      resolve({ status: incoming.statusCode, headers: incoming.headers, body: incoming, url: url.href })
    })
    request.once('error', () => { cleanup(); reject(signal?.aborted ? abortFault(signal) : fault('NETWORK_ERROR', 'The official download service could not be reached.')) })
    if (signal?.aborted) abort()
    else request.end()
  }), signal)
}

// Add browser-equivalent quarantine provenance; never remove quarantine,
// suppress OS review, run a shell, or execute an installer. -s avoids following
// an incidental symlink replacement; the owned file is checked again afterward.
async function markDownloadedFile(file, value) {
  await executeFile('/usr/bin/xattr', ['-s', '-w', 'com.apple.quarantine', value, file],
    { timeout: 5000, maxBuffer: 4096, windowsHide: true, shell: false })
}

function createToolSetupInstaller({ getDownloadsPath, optionalSetup, confirm, openPath, assertCanStart = async () => {},
  fs = fsPromises, fetch = publicFetch, platform = process.platform, arch = process.arch, release = os.release(),
  totalmem = os.totalmem(), homeDir = os.homedir(), now = Date.now, metadataMs = LIMITS.metadataMs,
  downloadMs = LIMITS.downloadMs, planMs = LIMITS.planMs, markQuarantine = markDownloadedFile } = {}) {
  const plans = new Map(), jobs = new Map(), controllers = new Map()
  let disposed = false, actionBusy = false
  metadataMs = Math.max(1, Math.min(LIMITS.metadataMs, metadataMs))
  downloadMs = Math.max(1, Math.min(LIMITS.downloadMs, downloadMs))
  planMs = Math.max(1, Math.min(LIMITS.planMs, planMs))
  const safeError = error => error?.toolSetupFault ? failure(error.code, error.message)
    : failure('SETUP_FAILED', 'This setup action could not finish. No automatic retry or installation was performed.')
  const api = fn => async (...values) => { try { return await fn(...values) } catch (error) { return safeError(error) } }
  async function live(owner, action, signal) {
    checkedOwner(owner); checkAbort(signal)
    if (disposed) throw fault('DISPOSED', 'The setup session is closed.')
    try { await assertCanStart({ owner, action }) } catch { throw fault('UNAVAILABLE', 'Setup is no longer available in this desktop session. Check again when it is ready.') }
    checkAbort(signal)
    if (disposed) throw fault('DISPOSED', 'The setup session is closed.')
  }
  async function exists(file) { try { return await fs.lstat(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
  async function directory(file) {
    const stat = await fs.lstat(file)
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(file) !== file) throw fault('UNSAFE_DESTINATION', 'The setup download location must be a real directory, not a symbolic link.')
    return { path: file, id: identity(stat) }
  }
  async function rootSnapshot() {
    const given = await getDownloadsPath?.()
    if (typeof given !== 'string' || !path.isAbsolute(given) || given.includes('\0')) throw fault('UNSAFE_DESTINATION', 'A valid desktop Downloads directory is required.')
    const root = await directory(path.resolve(given))
    const folderPath = path.join(root.path, 'Velorn Setup')
    const folder = await exists(folderPath) ? await directory(folderPath) : null
    return { root, folder }
  }
  async function sameRoot(snapshot) {
    const actual = await rootSnapshot()
    if (JSON.stringify(actual) !== JSON.stringify(snapshot)) throw fault('DESTINATION_CHANGED', 'The download directory changed. Review a new setup plan.')
    return actual
  }
  async function space(snapshot, bytes) {
    if (typeof fs.statfs !== 'function') throw fault('DISK_UNKNOWN', 'Free disk space could not be checked. Use the official download guide instead.')
    const stat = await fs.statfs(snapshot.folder?.path || snapshot.root.path)
    const freeBytes = Number(stat.bavail) * Number(stat.bsize)
    if (!Number.isFinite(freeBytes)) throw fault('DISK_UNKNOWN', 'Free disk space could not be checked. Use the official download guide instead.')
    if (freeBytes < bytes) throw fault('INSUFFICIENT_SPACE', 'There is not enough free disk space for this installer download.')
  }
  async function unused(snapshot, filename) {
    if (!snapshot.folder) return
    const names = await fs.readdir(snapshot.folder.path)
    if (names.some(name => name.replace(/[. ]+$/, '').toLowerCase() === filename.toLowerCase())) throw fault('DESTINATION_EXISTS', 'The installer destination already exists. Nothing will be overwritten.')
  }
  async function request(integration, source, method, signal) {
    let url = source
    for (let hops = 0; ; hops++) {
      checkAbort(signal)
      if (!allowedUrl(integration, url)) throw fault('BLOCKED_SOURCE', 'The installer source is outside the reviewed official download catalog.')
      const response = await abortable(fetch(url, { method, redirect: 'manual', signal, credentials: 'omit' }), signal)
      if (response.url && response.url !== url) { await closeResponse(response); throw fault('BLOCKED_SOURCE', 'The download client followed an unreviewed redirect.') }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = header(response, 'location'); await closeResponse(response)
        if (!location || hops >= LIMITS.redirects) throw fault('BLOCKED_SOURCE', 'The official source returned an unsupported redirect.')
        try { url = new URL(location, url).href } catch { throw fault('BLOCKED_SOURCE', 'The official source returned an invalid redirect.') }
        continue
      }
      return { response, url }
    }
  }
  function sizeOf(response) {
    const length = header(response, 'content-length')
    const encoding = header(response, 'content-encoding')
    const type = header(response, 'content-type') || ''
    if (response.status !== 200 || encoding && encoding.toLowerCase() !== 'identity' || /text\/|json|html|xml/i.test(type)) throw fault('INVALID_DOWNLOAD', 'The official server did not return an uncompressed installer file.')
    if (!length || !/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) < 512 || Number(length) > LIMITS.maxBytes) {
      throw fault('UNKNOWN_SIZE', 'The installer size is missing, invalid or exceeds the 2 GiB limit. Use the official download guide.')
    }
    return Number(length)
  }
  async function installed(catalog) {
    if (platform !== 'darwin') return []
    const found = []
    for (const base of ['/Applications', path.join(homeDir, 'Applications')]) for (const name of catalog.apps) {
      const candidate = path.join(base, name)
      const stat = await exists(candidate)
      if (stat?.isDirectory() && !stat.isSymbolicLink() && (await exists(path.join(candidate, 'Contents', 'Info.plist')))?.isFile()) found.push(candidate)
    }
    return found
  }
  function prunePlans() {
    for (const [id, value] of plans) if (value.view.expiresAt <= now()) plans.delete(id)
    while (plans.size >= LIMITS.plans) plans.delete(plans.keys().next().value)
  }
  function jobView(job) {
    return { success: true, jobId: job.id, integration: job.integration, state: job.state,
      bytesReceived: job.bytes, totalBytes: job.totalBytes, canOpen: job.state === 'completed' && !job.invalidated,
      ...(job.error ? { error: job.error } : {}), ...(job.warning ? { warning: job.warning } : {}) }
  }
  function findJob(args, owner) {
    checkedOwner(owner)
    const id = argsOnly(args, 'jobId'), job = jobs.get(id)
    if (!job || job.owner !== owner) throw fault('UNKNOWN_JOB', 'No installer download with that ID belongs to this setup session.')
    return job
  }
  async function plan(args, owner) {
    const integration = argsOnly(args, 'integration'), catalog = Object.hasOwn(CATALOG, integration) ? CATALOG[integration] : null
    if (!catalog) throw fault('INVALID_REQUEST', 'Choose ComfyUI or LM Studio for optional installation setup.')
    await live(owner, 'plan')
    const controller = new AbortController(); controllers.set(controller, owner)
    const timer = setTimeout(() => controller.abort('timeout'), metadataMs)
    timer.unref?.()
    try {
      const signal = controller.signal
      const found = await abortable(installed(catalog), signal)
      const readiness = await abortable(optionalSetup?.inspect({ integration }), signal)
      await live(owner, 'plan', signal)
      const checked = readiness?.success === true
      const serviceFound = checked && (readiness.state === 'ready'
        || integration === 'lmstudio' && ['needs-model', 'problem'].includes(readiness.state)
        || integration === 'comfyui' && Array.isArray(readiness.connections) && readiness.connections.length > 0)
      const supported = platform === 'darwin' && arch === 'arm64' && Number.parseInt(release, 10) >= catalog.darwin
      const warnings = [catalog.storage, 'All tools are optional. Editing, captions and export remain available without them.',
        'Downloads do not install software, choose models, enable cloud spending, change security settings or start generation. You handle OS permission and installer prompts.']
      const memoryGiB = Math.round(Number(totalmem) / 1024 ** 3)
      if (Number.isFinite(memoryGiB) && memoryGiB < catalog.memoryGiB) warnings.push(`${catalog.name} recommends at least ${catalog.memoryGiB} GB RAM. Model compatibility is not established by this check.`)
      if (!supported) warnings.push('Automatic installer download is limited to supported Apple Silicon Macs. Use the official guide for this platform; no fallback installer will be downloaded.')
      if (found.length || serviceFound) warnings.push('An installation or responding service is already available. Configure or use it first instead of downloading another copy.')
      if (!checked) warnings.push('The existing setup could not be checked. Check again before deciding whether installation is needed.')
      const planId = randomUUID(), filename = `${catalog.filename}-${planId}.dmg`
      let bytes = null, snapshot = null, source = catalog.source, etag = null, canDownload = false
      if (supported && checked && !found.length && !serviceFound) {
        try {
          snapshot = await abortable(rootSnapshot(), signal)
          const result = await request(integration, catalog.source, 'HEAD', signal)
          try { bytes = sizeOf(result.response); source = result.url; etag = header(result.response, 'etag') } finally { await closeResponse(result.response) }
          await space(snapshot, bytes); await sameRoot(snapshot)
          canDownload = true
        } catch (error) {
          checkAbort(signal)
          warnings.push(error.toolSetupFault ? error.message : 'The download details or destination could not be verified. Use the official guide instead.')
        }
      }
      await live(owner, 'plan', signal)
      const view = { success: true, planId, integration, name: catalog.name,
        host: { platform, arch, memoryGiB: Number.isFinite(memoryGiB) ? memoryGiB : null },
        readiness: object(readiness) ? readiness : { success: false, state: 'problem', summary: 'The existing connection could not be checked.' },
        installation: { found: found.length > 0, summary: found.length ? 'An app was found in a standard Applications location; its running state is checked separately.' : 'No app was found in the checked standard locations. It may be installed elsewhere.' },
        download: { supported, sourceUrl: supported ? source : catalog.guide, bytes, maxBytes: LIMITS.maxBytes,
          destination: `Downloads/Velorn Setup/${filename}`, canDownload },
        guideUrl: catalog.guide, steps: found.length || serviceFound
          ? ['Use the detected app or responding local service first; downloading another installer is disabled.',
            ...(Array.isArray(readiness?.nextActions) ? readiness.nextActions : []), ...catalog.steps.slice(2)]
          : !checked ? ['Check setup again when the existing integration can be inspected.', 'Use the official guide if you need installation help. No installer download is enabled by this uncertain check.']
            : [...catalog.steps], warnings, expiresAt: now() + planMs }
      prunePlans(); plans.set(planId, { owner, view, snapshot, filename, source, found, bytes, etag })
      return structuredClone(view)
    } finally { clearTimeout(timer); controllers.delete(controller) }
  }
  async function cleanupPartial(job) {
    if (!job.partial || !job.partialId) return
    // Never delete through a changed parent, or remove any unowned replacement.
    try { await sameRoot(job.snapshot) } catch { job.warning = 'The download directory changed; its partial file was left untouched.'; return }
    const stat = await exists(job.partial)
    if (stat?.isFile() && !stat.isSymbolicLink() && identity(stat) === job.partialId) await fs.unlink(job.partial)
    else if (stat) job.warning = 'A changed partial file was left untouched.'
  }
  async function prepareFolder(job) {
    await sameRoot(job.snapshot)
    if (!job.snapshot.folder) {
      const folderPath = path.join(job.snapshot.root.path, 'Velorn Setup')
      try { await fs.mkdir(folderPath, { mode: 0o700 }) }
      catch { throw fault('DESTINATION_CHANGED', 'The setup directory could not be created safely. Review a new plan.') }
      const actual = await rootSnapshot()
      if (JSON.stringify(actual.root) !== JSON.stringify(job.snapshot.root)) throw fault('DESTINATION_CHANGED', 'The Downloads directory changed while preparing the download.')
      job.snapshot = actual
    }
    await sameRoot(job.snapshot); await unused(job.snapshot, job.filename); await space(job.snapshot, job.totalBytes)
  }
  async function run(job) {
    const signal = job.controller.signal
    let file, response, finalState = 'failed', finalError
    try {
      await live(job.owner, 'download-background', signal); await prepareFolder(job)
      await live(job.owner, 'download-background', signal); await sameRoot(job.snapshot)
      job.partial = path.join(job.snapshot.folder.path, `.velorn-setup-${job.id}.partial`)
      file = await fs.open(job.partial, nativeFs.constants.O_CREAT | nativeFs.constants.O_EXCL | nativeFs.constants.O_RDWR | (nativeFs.constants.O_NOFOLLOW || 0), 0o600)
      job.partialId = identity(await file.stat())
      await live(job.owner, 'download-background', signal); await sameRoot(job.snapshot)
      const result = await request(job.integration, job.source, 'GET', signal); response = result.response
      if (result.url !== job.source || sizeOf(response) !== job.totalBytes || job.etag && header(response, 'etag') !== job.etag) throw fault('DOWNLOAD_CHANGED', 'The official installer changed after review. Request a new setup plan.')
      if (!response.body?.[Symbol.asyncIterator]) throw fault('INVALID_DOWNLOAD', 'The installer download did not provide a supported stream.')
      const hash = createHash('sha256'), iterator = response.body[Symbol.asyncIterator]()
      while (true) {
        const item = await abortable(iterator.next(), signal)
        if (item.done) break
        if (!(item.value instanceof Uint8Array)) throw fault('INVALID_DOWNLOAD', 'The installer response was not binary data.')
        const chunk = Buffer.from(item.value)
        if (job.bytes + chunk.length > job.totalBytes || job.bytes + chunk.length > LIMITS.maxBytes) throw fault('DOWNLOAD_TOO_LARGE', 'The installer exceeded the approved download size.')
        await live(job.owner, 'download-background', signal); await sameRoot(job.snapshot)
        let offset = 0
        while (offset < chunk.length) {
          checkAbort(signal)
          const written = await file.write(chunk, offset, chunk.length - offset)
          if (!written.bytesWritten) throw fault('WRITE_FAILED', 'The installer partial file could not be written.')
          offset += written.bytesWritten
        }
        hash.update(chunk); job.bytes += chunk.length
      }
      if (job.bytes !== job.totalBytes) throw fault('INCOMPLETE_DOWNLOAD', 'The installer ended before its approved size was received.')
      // UDIF DMGs have a 512-byte trailer beginning with koly. A catalog URL
      // returning a same-sized HTML/error body must not become an openable file.
      const trailer = Buffer.alloc(4)
      if ((await file.read(trailer, 0, 4, job.bytes - 512)).bytesRead !== 4 || trailer.toString('ascii') !== 'koly') throw fault('INVALID_DOWNLOAD', 'The response is not a recognized DMG installer.')
      job.sha256 = hash.digest('hex'); await file.sync()
      await live(job.owner, 'download-background', signal); await sameRoot(job.snapshot); await unused(job.snapshot, job.filename)
      const current = await fs.lstat(job.partial)
      if (!current.isFile() || current.isSymbolicLink() || identity(current) !== job.partialId) throw fault('DESTINATION_CHANGED', 'The installer partial file changed before completion.')
      // Mark the owned partial before promotion, so metadata failure leaves no
      // openable final DMG. Hard-link promotion preserves the quarantine xattr.
      try {
        if (typeof markQuarantine !== 'function') throw new Error('Unavailable')
        const marked = await abortable(markQuarantine(job.partial, `0083;${Math.floor(now() / 1000).toString(16)};Velorn;${randomUUID()}`), signal)
        if (marked === false) throw new Error('Not marked')
      } catch {
        checkAbort(signal)
        throw fault('QUARANTINE_FAILED', 'The installer could not be marked for macOS security review. It was not made available to open.')
      }
      await sameRoot(job.snapshot)
      const markedStat = await fs.lstat(job.partial)
      if (!markedStat.isFile() || markedStat.isSymbolicLink() || identity(markedStat) !== job.partialId || markedStat.size !== job.totalBytes
        || identity(await file.stat()) !== job.partialId || await digestFile(file, job, 'download-background', signal) !== job.sha256) {
        throw fault('INSTALLER_CHANGED', 'The installer changed while recording download provenance. It was not made available to open.')
      }
      await live(job.owner, 'download-background', signal)
      job.destination = path.join(job.snapshot.folder.path, job.filename)
      try { await fs.link(job.partial, job.destination) }
      catch (error) { throw fault(error.code === 'EEXIST' ? 'DESTINATION_EXISTS' : 'PROMOTION_FAILED', 'The completed installer could not be saved without overwriting. No installer was opened.') }
      job.fileId = job.partialId
      finalState = 'completed'
    } catch (error) {
      finalState = signal.aborted && signal.reason !== 'timeout' ? 'cancelled' : 'failed'
      const result = safeError(signal.aborted ? abortFault(signal) : error)
      finalError = { code: result.code, message: result.error }
    } finally {
      await closeResponse(response)
      try { await file?.close() } catch {}
      try { await cleanupPartial(job) } catch { job.warning = 'The owned partial file could not be removed.' }
      clearTimeout(job.timer); controllers.delete(job.controller)
      // unlinking our partial hardlink changes the final inode's ctime. Publish
      // completion only after cleanup, so an immediate open cannot race it.
      if (finalError) job.error = finalError
      job.state = finalState
    }
  }
  async function download(args, owner) {
    const id = argsOnly(args, 'planId'), plan = plans.get(id)
    await live(owner, 'download')
    if (!plan || plan.owner !== owner || plan.view.expiresAt <= now()) throw fault('INVALID_PLAN', 'The setup plan is missing, expired or belongs to another session. Review a new plan.')
    if (!plan.view.download.canDownload) throw fault('DOWNLOAD_UNAVAILABLE', 'This plan does not permit downloading another installer. Follow its setup guidance instead.')
    if (actionBusy || [...jobs.values()].some(job => !terminal(job))) throw fault('BUSY', 'Another installer action is running. Wait for it to finish.')
    actionBusy = true
    try {
      await sameRoot(plan.snapshot); await unused(plan.snapshot, plan.filename); await space(plan.snapshot, plan.bytes)
      await live(owner, 'download')
      const destination = path.join(plan.snapshot.root.path, 'Velorn Setup', plan.filename)
      const approved = await confirm?.({ owner, action: 'download', plan: structuredClone(plan.view), destination, sourceUrl: plan.source, bytes: plan.bytes })
      await live(owner, 'download')
      if (approved !== true) throw fault('DECLINED', 'Installer download was not approved. Nothing was downloaded.')
      // A declined dialog leaves the plan reusable; approved authority is single use.
      if (plans.get(id) !== plan || plan.view.expiresAt <= now()) throw fault('INVALID_PLAN', 'The setup plan expired while awaiting approval. Review a new plan.')
      plans.delete(id)
      await sameRoot(plan.snapshot); await unused(plan.snapshot, plan.filename); await space(plan.snapshot, plan.bytes)
      await live(owner, 'download')
      while (jobs.size >= LIMITS.jobs) {
        const previous = [...jobs.values()].find(terminal)
        if (!previous) throw fault('BUSY', 'The installer job list is full.')
        jobs.delete(previous.id)
      }
      const job = { id: randomUUID(), owner, integration: plan.view.integration, name: plan.view.name,
        filename: plan.filename, source: plan.source, etag: plan.etag, snapshot: plan.snapshot, state: 'downloading', bytes: 0,
        totalBytes: plan.bytes, controller: new AbortController() }
      controllers.set(job.controller, owner); jobs.set(job.id, job)
      job.timer = setTimeout(() => job.controller.abort('timeout'), downloadMs); job.timer.unref?.()
      job.done = run(job)
      return jobView(job)
    } finally { actionBusy = false }
  }
  async function status(args, owner) { const job = findJob(args, owner); await live(owner, 'status'); return jobView(job) }
  async function cancel(args, owner) {
    const job = findJob(args, owner)
    if (!terminal(job)) { job.controller.abort('cancelled'); await job.done }
    return jobView(job)
  }
  async function digestFile(handle, job, action, signal) {
    const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024)
    let offset = 0
    while (offset < job.totalBytes) {
      await live(job.owner, action, signal)
      const read = await handle.read(buffer, 0, Math.min(buffer.length, job.totalBytes - offset), offset)
      if (!read.bytesRead) throw fault('INSTALLER_CHANGED', 'The completed installer is incomplete.')
      hash.update(buffer.subarray(0, read.bytesRead)); offset += read.bytesRead
    }
    return hash.digest('hex')
  }
  async function verifyFile(job) {
    await sameRoot(job.snapshot)
    const stat = await fs.lstat(job.destination)
    if (!stat.isFile() || stat.isSymbolicLink() || identity(stat) !== job.fileId || stat.size !== job.totalBytes) throw fault('INSTALLER_CHANGED', 'The completed installer changed. It will not be opened.')
    const handle = await fs.open(job.destination, nativeFs.constants.O_RDONLY | (nativeFs.constants.O_NOFOLLOW || 0))
    try {
      if (identity(await handle.stat()) !== job.fileId) throw fault('INSTALLER_CHANGED', 'The completed installer changed. It will not be opened.')
      if (await digestFile(handle, job, 'open-verification') !== job.sha256) throw fault('INSTALLER_CHANGED', 'The completed installer no longer matches the downloaded file.')
      await sameRoot(job.snapshot)
      const final = await fs.lstat(job.destination)
      if (!final.isFile() || final.isSymbolicLink() || identity(final) !== job.fileId || final.size !== job.totalBytes || final.mtimeMs !== stat.mtimeMs || final.ctimeMs !== stat.ctimeMs) throw fault('INSTALLER_CHANGED', 'The completed installer changed during verification.')
    } finally { await handle.close() }
  }
  async function open(args, owner) {
    const job = findJob(args, owner)
    await live(owner, 'open')
    if (job.state !== 'completed') throw fault('NOT_COMPLETED', 'Only a completed, verified installer download can be opened.')
    if (job.invalidated) throw fault('INSTALLER_CHANGED', 'The completed installer could not be verified. Review a new download instead.')
    if (actionBusy) throw fault('BUSY', 'Another installer action is running.')
    actionBusy = true
    try {
      const approved = await confirm?.({ owner, action: 'open', job: jobView(job), name: job.name, destination: job.destination,
        sourceUrl: job.source, bytes: job.totalBytes })
      await live(owner, 'open')
      if (approved !== true) throw fault('DECLINED', 'Opening the installer was not approved.')
      if (typeof openPath !== 'function') throw fault('OPEN_UNAVAILABLE', 'The desktop installer opener is unavailable.')
      // The controller first awaits its final context guard, then invokes this
      // host-only callback immediately before its synchronous ownership check
      // and OS handoff. Do not insert an IPC/context roundtrip after hashing.
      let verified = false
      const beforeOpen = async () => {
        try { await verifyFile(job); verified = true }
        catch (error) { job.invalidated = true; throw error }
      }
      const result = await openPath(job.destination, { owner, beforeOpen })
      if (result) throw fault('OPEN_FAILED', 'The operating system could not open the installer.')
      if (!verified) throw fault('OPEN_UNAVAILABLE', 'The desktop opener did not verify the installer before its handoff.')
      return { ...jobView(job), opened: true, installed: false,
        message: 'The DMG was handed to the operating system. Complete installation and permissions yourself, then return to check setup.' }
    } finally { actionBusy = false }
  }
  async function dispose() {
    disposed = true; plans.clear()
    for (const controller of controllers.keys()) controller.abort('disposed')
    await Promise.all([...jobs.values()].map(job => job.done).filter(Boolean))
  }
  async function cancelOwner(owner) {
    checkedOwner(owner)
    for (const [id, entry] of plans) if (entry.owner === owner) plans.delete(id)
    for (const [controller, controllerOwner] of controllers) if (controllerOwner === owner) controller.abort('owner-closed')
    const owned = [...jobs.values()].filter(job => job.owner === owner && !terminal(job))
    for (const job of owned) job.controller.abort('owner-closed')
    await Promise.all(owned.map(job => job.done))
  }
  return { plan: api(plan), download: api(download), status: api(status), cancel: api(cancel), open: api(open), cancelOwner, dispose }
}

module.exports = { createToolSetupInstaller, LIMITS, CATALOG, allowedUrl }
