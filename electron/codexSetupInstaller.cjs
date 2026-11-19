'use strict'

// Deliberately separate from provider authentication. This installer never
// executes Codex, changes PATH/selection, or reads/writes Codex account files.
const fs = require('node:fs/promises')
const { constants } = require('node:fs')
const path = require('node:path')
const https = require('node:https')
const dns = require('node:dns/promises')
const { createGunzip } = require('node:zlib')
const { randomUUID, createHash } = require('node:crypto')
const { isPublicAddress } = require('./agentResearchWeb.cjs')

// Reviewed against the public OpenAI GitHub release API on 2026-11-03. Do not
// resolve a mutable 'latest' URL at install time or accept renderer manifests.
const VERSION = '0.166.0'
const TARGETS = Object.freeze({
  x64: Object.freeze({ target: 'x86_64-unknown-linux-musl', bytes: 121764138,
    sha256: 'a0bf572d2f93f056c6712a6da348e96078dc84f3885fd7be67807ef389cb3978', machine: 62 }),
  arm64: Object.freeze({ target: 'aarch64-unknown-linux-musl', bytes: 113382496,
    sha256: '94eb707605ec2646b2e05b7edf7c4e7b3ccf02b16237c34ae9beb8cfb7f810a9', machine: 183 }),
})
const LIMITS = Object.freeze({ planMs: 300000, downloadMs: 900000, archiveBytes: 160 * 1024 ** 2,
  binaryBytes: 512 * 1024 ** 2, records: 16, jobs: 16, redirects: 4 })
const GUIDE = 'https://learn.chatgpt.com/docs/codex/cli'
const managedDirectory = home => path.join(home, '.local', 'share', 'velorn', 'tools', 'codex')
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const fault = (code, message) => Object.assign(new Error(message), { code, codexInstall: true })
const assertLive = signal => { if (signal?.aborted) throw fault('CANCELLED', 'Codex installation stopped. Your existing account and chats are unchanged.') }
function abortable(promise, signal) {
  assertLive(signal)
  return new Promise((resolve, reject) => {
    const abort = () => reject(fault('CANCELLED', 'Codex installation stopped.'))
    signal?.addEventListener('abort', abort, { once: true })
    Promise.resolve(promise).then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort))
  })
}
async function writeAll(handle, bytes, signal) {
  for (let offset = 0; offset < bytes.length;) {
    assertLive(signal)
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset)
    if (!Number.isInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > bytes.length - offset) throw fault('WRITE_FAILED', 'The Codex file could not be saved completely.')
    offset += bytesWritten
  }
}
const resultError = e => ({ success: false, code: e?.codexInstall ? e.code : 'INSTALL_FAILED',
  error: e?.codexInstall ? e.message : 'Codex could not be installed. Check free space and Troubleshooting, then try again.' })
const id = value => typeof value === 'string' && /^[\w-]{1,100}$/.test(value)
function payload(value, key) {
  if (!object(value) || Object.keys(value).length !== (key ? 1 : 0) || key && !id(value[key])) throw fault('INVALID_REQUEST', 'This setup action is invalid.')
}
function sourceFor(target) { return `https://github.com/openai/codex/releases/download/rust-v${VERSION}/codex-${target.target}.tar.gz` }
function allowedDownloadUrl(value, initial) {
  let url
  try { url = new URL(value) } catch { return false }
  if (url.href.length > 16000 || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || /[\\\x00-\x20\x7f]/.test(value)) return false
  return url.href === initial || ['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname)
    && /^\/github-production-release-asset(?:-2e65be)?\/[A-Za-z0-9/_.-]+$/.test(url.pathname)
}
// Fixed official HTTPS source; every redirect and connected DNS address is
// checked. No credentials, cookies, shell, proxies or automatic retries.
async function downloadResponse(value, { signal, initial = value, redirects = 0 } = {}) {
  assertLive(signal)
  if (!allowedDownloadUrl(value, initial) || redirects > LIMITS.redirects) throw fault('BLOCKED_SOURCE', 'The official download redirected to an unexpected location. Use Troubleshooting.')
  const url = new URL(value)
  const addresses = await abortable(dns.lookup(url.hostname, { all: true, verbatim: true }), signal)
  assertLive(signal)
  if (!addresses.length || addresses.length > 32 || addresses.some(a => !isPublicAddress(a.address))) throw fault('BLOCKED_SOURCE', 'The download host could not be verified.')
  const address = addresses[0]
  const response = await new Promise((resolve, reject) => {
    const request = https.request({ protocol: 'https:', hostname: url.hostname, port: 443,
      path: url.pathname + url.search, method: 'GET', agent: false, servername: url.hostname, rejectUnauthorized: true,
      signal, maxHeaderSize: 16384, family: address.family, autoSelectFamily: false,
      lookup: (_name, options, cb) => typeof options === 'function' ? options(null, address.address, address.family)
        : options?.all ? cb(null, [address]) : cb(null, address.address, address.family),
      headers: { Accept: 'application/octet-stream', 'Accept-Encoding': 'identity', 'User-Agent': 'Velorn-Codex-Setup/1.0' },
    }, incoming => {
      if (incoming.socket.remoteAddress?.replace(/^::ffff:/, '') !== address.address.replace(/^::ffff:/, '')) {
        incoming.destroy(); reject(fault('BLOCKED_SOURCE', 'The download connection could not be verified.')); return
      }
      incoming.on('error', () => {})
      resolve(incoming)
    })
    request.on('error', () => reject(signal?.aborted ? fault('CANCELLED', 'Codex installation stopped.') : fault('NETWORK_ERROR', 'The official Codex download could not be reached. Try again when online.')))
    request.setTimeout(30000, () => request.destroy())
    request.end()
  })
  if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
    const location = response.headers.location; response.destroy()
    if (typeof location !== 'string') throw fault('BLOCKED_SOURCE', 'The download redirect is incomplete.')
    return downloadResponse(new URL(location, value).href, { signal, initial, redirects: redirects + 1 })
  }
  if (response.statusCode !== 200) { response.destroy(); throw fault('NETWORK_ERROR', 'The official Codex download is unavailable. Try again later.') }
  return { headers: response.headers, body: response }
}
const ident = info => `${info.dev}:${info.ino}`
async function existing(file) { try { return await fs.lstat(file) } catch (e) { if (e.code === 'ENOENT') return null; throw e } }

// Extract exactly one named regular file. Never hand untrusted archive paths
// to a filesystem extractor; reject links, metadata/PAX, extra files and bombs.
async function extractBinary(archive, output, target, signal) {
  const input = require('node:fs').createReadStream(archive)
  const unzip = createGunzip()
  // Cancellation may arrive while the exclusive output open is pending,
  // before the async iterator has attached its error listener.
  unzip.on('error', () => {})
  const abort = () => { input.destroy(); unzip.destroy(fault('CANCELLED', 'Codex installation stopped.')) }
  input.on('error', e => unzip.destroy(e)); input.pipe(unzip)
  signal.addEventListener('abort', abort, { once: true })
  let handle, buffer = Buffer.alloc(0), remaining = 0, padding = 0, count = 0, total = 0, binaryBytes = 0, ended = false, zeros = 0
  const hash = createHash('sha256'), header = Buffer.alloc(64); let headerBytes = 0
  const octal = b => { const s = b.toString('ascii').replace(/\0.*$/, '').trim(); if (!/^[0-7]+$/.test(s)) throw fault('INVALID_ARCHIVE', 'The Codex archive has invalid metadata.'); return Number.parseInt(s, 8) }
  try {
    handle = await fs.open(output, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    for await (const chunk of unzip) {
      assertLive(signal); total += chunk.length
      if (total > LIMITS.binaryBytes + 16384) throw fault('INVALID_ARCHIVE', 'The Codex archive is larger than expected.')
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length) {
        if (remaining) {
          const part = buffer.subarray(0, Math.min(buffer.length, remaining)); remaining -= part.length; buffer = buffer.subarray(part.length)
          const n = Math.min(64 - headerBytes, part.length); if (n) { part.copy(header, headerBytes, 0, n); headerBytes += n }
          hash.update(part); await writeAll(handle, part, signal); continue
        }
        if (padding) { const n = Math.min(padding, buffer.length); padding -= n; buffer = buffer.subarray(n); continue }
        if (buffer.length < 512) break
        const block = buffer.subarray(0, 512); buffer = buffer.subarray(512)
        if (block.every(x => x === 0)) { zeros++; ended = true; continue }
        if (ended || ++count !== 1 || count > LIMITS.records) throw fault('INVALID_ARCHIVE', 'The Codex archive contains unexpected entries.')
        const checksum = octal(block.subarray(148, 156)); let actual = 0
        for (let i = 0; i < 512; i++) actual += i >= 148 && i < 156 ? 32 : block[i]
        const name = block.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
        const prefix = block.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
        if (actual !== checksum || prefix || ![0, 48].includes(block[156]) || block.subarray(157, 257).some(x => x !== 0)
          || ![`codex-${target.target}`, `./codex-${target.target}`].includes(name)) throw fault('INVALID_ARCHIVE', 'The Codex archive does not contain the expected regular executable.')
        binaryBytes = octal(block.subarray(124, 136))
        if (binaryBytes < 64 || binaryBytes > LIMITS.binaryBytes) throw fault('INVALID_ARCHIVE', 'The Codex executable size is invalid.')
        remaining = binaryBytes; padding = (512 - binaryBytes % 512) % 512
      }
    }
    assertLive(signal)
    if (count !== 1 || remaining || padding || zeros < 2 || buffer.some(x => x !== 0)) throw fault('INVALID_ARCHIVE', 'The Codex archive is incomplete.')
    if (headerBytes !== 64 || !header.subarray(0, 4).equals(Buffer.from([0x7f, 69, 76, 70])) || header[4] !== 2 || header[5] !== 1
      || ![2, 3].includes(header.readUInt16LE(16)) || header.readUInt16LE(18) !== target.machine) throw fault('WRONG_ARCHITECTURE', 'The downloaded Codex executable is not for this computer.')
    await handle.sync(); await handle.chmod(0o700)
    return { bytes: binaryBytes, sha256: hash.digest('hex'), identity: ident(await handle.stat()) }
  } finally {
    signal.removeEventListener('abort', abort); input.destroy(); unzip.destroy()
    await handle?.close()
  }
}

function createCodexSetupInstaller({ getHomeDirectory, inspectExisting, confirm, assertCurrent = async () => {},
  fetch = downloadResponse, platform = process.platform, arch = process.arch, uid = process.getuid?.(),
  targets = TARGETS, now = Date.now, downloadMs = LIMITS.downloadMs } = {}) {
  const plans = new Map(), jobs = new Map(); let busy = false, disposed = false
  const target = platform === 'linux' ? targets[arch] : null
  const checked = async (owner, action, signal) => {
    if (!id(owner) || disposed) throw fault('UNAVAILABLE', 'Reopen Codex setup to continue.')
    assertLive(signal); await assertCurrent(owner, action); assertLive(signal)
    if (disposed) throw fault('UNAVAILABLE', 'Codex setup has closed.')
  }
  const noExisting = async () => { if (await inspectExisting()) throw fault('ALREADY_INSTALLED', 'An existing Codex installation or custom selection was found. Check its connection; it will not be replaced.') }
  async function location(create = false) {
    const home = await getHomeDirectory()
    if (typeof home !== 'string' || !path.isAbsolute(home) || home === '/' || /[\x00-\x1f\x7f]/.test(home) || path.resolve(home) !== home) throw fault('UNSAFE_DESTINATION', 'The user installation directory is unavailable.')
    const parts = [home, '.local', 'share', 'velorn', 'tools', 'codex']; let current = '', snapshots = []
    for (const part of parts) {
      current = current ? path.join(current, part) : part
      let info = await existing(current)
      if (!info && create) { try { await fs.mkdir(current, { mode: 0o700 }) } catch (e) { if (e.code !== 'EEXIST') throw e }; info = await fs.lstat(current) }
      if (info) {
        if (!info.isDirectory() || info.isSymbolicLink() || await fs.realpath(current) !== current || uid != null && info.uid !== uid || info.mode & 0o002) throw fault('UNSAFE_DESTINATION', 'The Codex destination must be your own folder, not a link or a publicly writable folder. Use Troubleshooting for another installation method.')
        snapshots.push([current, ident(info)])
      } else snapshots.push([current, null])
    }
    return { directory: current, destination: path.join(current, 'codex'), snapshots }
  }
  const same = async snapshot => {
    const next = await location(false)
    if (JSON.stringify(snapshot) !== JSON.stringify(next)) throw fault('DESTINATION_CHANGED', 'The installation directory changed. Start setup again.')
  }
  const view = j => ({ success: true, jobId: j.id, state: j.state, bytesReceived: j.bytesReceived, totalBytes: j.target.bytes,
    ...(j.error ? { error: j.error.error, code: j.error.code } : {}) })
  const api = fn => async (...args) => { try { return await fn(...args) } catch (e) { return resultError(e) } }
  async function perform(job, snapshot) {
    let stage, stageIdentity, archive, binary, source, handle
    const signal = job.controller.signal
    const timer = setTimeout(() => job.controller.abort(), Math.max(1, Math.min(downloadMs, LIMITS.downloadMs)))
    try {
      await checked(job.owner, 'install-background', signal); await same(snapshot); await noExisting()
      const destination = await location(true); await checked(job.owner, 'install-background', signal)
      if (await existing(destination.destination)) throw fault('ALREADY_INSTALLED', 'The Codex destination already exists. Nothing was replaced.')
      stage = await fs.mkdtemp(path.join(destination.directory, '.install-')); await fs.chmod(stage, 0o700)
      stageIdentity = ident(await fs.lstat(stage))
      archive = path.join(stage, 'download.tar.gz'); binary = path.join(stage, 'codex')
      handle = await fs.open(archive, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
      const response = await abortable(fetch(sourceFor(job.target), { signal }), signal); source = response.body
      const length = Number(response.headers?.['content-length'])
      if (!Number.isSafeInteger(length) || length !== job.target.bytes || response.headers?.['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw fault('INTEGRITY_FAILED', 'The official download size changed. Use Troubleshooting; nothing was installed.')
      const hash = createHash('sha256')
      for await (const chunk of source) {
        await checked(job.owner, 'install-background', signal)
        const bytes = Buffer.from(chunk); job.bytesReceived += bytes.length
        if (job.bytesReceived > job.target.bytes || job.bytesReceived > LIMITS.archiveBytes) throw fault('INTEGRITY_FAILED', 'The Codex download was larger than expected.')
        hash.update(bytes); await writeAll(handle, bytes, signal)
      }
      await handle.sync(); await handle.close(); handle = null; job.state = 'verifying'
      if (job.bytesReceived !== job.target.bytes || hash.digest('hex') !== job.target.sha256) throw fault('INTEGRITY_FAILED', 'The Codex checksum did not match. Nothing was installed; try again or use Troubleshooting.')
      await checked(job.owner, 'install-background', signal); await same(destination)
      const verified = await extractBinary(archive, binary, job.target, signal)
      job.state = 'installing'
      await checked(job.owner, 'install-background', signal); await same(destination); await noExisting()
      if (await fs.realpath(stage) !== stage || ident(await fs.lstat(stage)) !== stageIdentity) throw fault('DESTINATION_CHANGED', 'The installation staging directory changed.')
      const ready = await fs.lstat(binary)
      if (!ready.isFile() || ready.isSymbolicLink() || ident(ready) !== verified.identity || ready.size !== verified.bytes) throw fault('DESTINATION_CHANGED', 'The verified Codex file changed before installation.')
      await checked(job.owner, 'install-background', signal)
      // Atomic no-clobber publication: never replace an existing binary.
      await fs.link(binary, destination.destination)
      job.state = 'completed'
    } catch (error) {
      job.state = signal.aborted || error.code === 'CANCELLED' ? 'cancelled' : 'failed'
      job.error = resultError(signal.aborted ? fault('CANCELLED', 'Installation cancelled. No sign-in or account change occurred.') : error)
    } finally {
      clearTimeout(timer); source?.destroy?.(); await handle?.close().catch(() => {})
      // Only exact files in this job's freshly created staging directory.
      try {
        if (stage && await fs.realpath(stage).catch(() => '') === stage && ident(await fs.lstat(stage)) === stageIdentity) {
          for (const file of [archive, binary].filter(Boolean)) await fs.unlink(file).catch(() => {})
          await fs.rmdir(stage).catch(() => {})
        }
      } catch {} finally { busy = false }
    }
  }
  return {
    plan: api(async (args, owner) => {
      payload(args); await checked(owner, 'plan')
      if (!target) return { success: true, supported: false, guide: GUIDE, error: 'Guided installation is available on Linux Intel/AMD and ARM64. Use the official guide on this computer.' }
      if (busy) throw fault('BUSY', 'An installation is already running.')
      await noExisting(); const root = await location(); await checked(owner, 'plan')
      if (await existing(root.destination)) throw fault('ALREADY_INSTALLED', 'The Codex destination already exists. Nothing was changed.')
      plans.clear(); const planId = randomUUID(); plans.set(planId, { owner, root, expires: now() + LIMITS.planMs })
      return { success: true, supported: true, planId, version: VERSION, bytes: target.bytes, source: sourceFor(target), destination: root.destination }
    }),
    install: api(async (args, owner) => {
      payload(args, 'planId'); await checked(owner, 'install')
      const plan = plans.get(args.planId)
      if (!plan || plan.owner !== owner || plan.expires < now()) throw fault('STALE_PLAN', 'Check installation again before continuing.')
      if (busy || jobs.size >= LIMITS.jobs) throw fault('BUSY', 'Finish the current setup or reopen Velorn before trying again.')
      busy = true
      try {
        await same(plan.root); await noExisting()
        const approved = await confirm({ owner, version: VERSION, bytes: target.bytes, source: sourceFor(target), destination: plan.root.destination })
        await checked(owner, 'install'); await same(plan.root); await noExisting()
        if (!approved) { busy = false; return { success: true, cancelled: true } }
        if (plan.expires < now() || plans.get(args.planId) !== plan) throw fault('STALE_PLAN', 'The installation review expired. Check again.')
        plans.delete(args.planId)
        const job = { id: randomUUID(), owner, target, state: 'downloading', bytesReceived: 0, controller: new AbortController() }
        jobs.set(job.id, job); job.promise = perform(job, plan.root)
        return view(job)
      } catch (e) { busy = false; throw e }
    }),
    status: api(async (args, owner) => { payload(args, 'jobId'); await checked(owner, 'status'); const j = jobs.get(args.jobId); if (!j || j.owner !== owner) throw fault('UNKNOWN_JOB', 'This installation is not part of the current setup.'); return view(j) }),
    cancel: api(async (args, owner) => { payload(args, 'jobId'); await checked(owner, 'cancel'); const j = jobs.get(args.jobId); if (!j || j.owner !== owner) throw fault('UNKNOWN_JOB', 'This installation is not part of the current setup.'); if (!['completed', 'failed', 'cancelled'].includes(j.state)) { j.controller.abort(); await j.promise }; return view(j) }),
    cancelOwner(owner) { for (const [key, p] of plans) if (p.owner === owner) plans.delete(key); for (const j of jobs.values()) if (j.owner === owner && !['completed', 'failed', 'cancelled'].includes(j.state)) j.controller.abort() },
    dispose() { disposed = true; plans.clear(); for (const j of jobs.values()) j.controller.abort() },
  }
}

module.exports = { createCodexSetupInstaller, VERSION, TARGETS, LIMITS, GUIDE, managedDirectory, sourceFor, allowedDownloadUrl, extractBinary, writeAll, abortable }
