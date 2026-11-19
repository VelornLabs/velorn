'use strict'

// A deliberately narrow, native-owned Router path. It never submits a local
// ComfyUI graph or reads the Partner/Hosted credential stores.
const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const path = require('node:path')
const { randomUUID, randomInt, createHash } = require('node:crypto')
const { catalog, getModel, getVoice, fallbackPrice, listModels, listVoices, sizesFor, resolutionsFor, AUDIO_KINDS } = require('./createModels.cjs')
const { buildCreateRequest } = require('./createRequests.cjs')

const ORIGIN = 'https://api.comfy.org'
const MODEL = 'byteplus/seedream-4-0-250828'
const MODEL_LABEL = 'Seedream 4.0'
const WIDTH = 1024, HEIGHT = 1024
const ESTIMATE = Object.freeze({ currency: 'USD', amount: 0.03, usd: 0.03, credits: 6.33, asOf: '2026-10-01',
  source: 'https://docs.comfy.org/development/comfy-router/pricing.md',
  label: 'Estimated 6.33 Comfy credits ($0.03) for one image. Published October 1, 2026; final provider billing may differ.' })
const LIMITS = Object.freeze({ prompt: 4000, key: 4096, response: 262144, result: 140 * 1024 * 1024, image: 100 * 1024 * 1024, ledger: 1024 * 1024,
  jobs: 500, plans: 32, planMs: 10 * 60 * 1000, timeoutMs: 30000 })
const STATES = new Set(['SUBMITTING', 'UNCERTAIN', 'IN_QUEUE', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED'])
const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED'])
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const exact = (v, keys) => object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k))
const identifier = v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(v)
const empty = v => exact(v, [])
const validKey = v => typeof v === 'string' && v.length > 0 && v.length <= LIMITS.key && !/[\s\x00-\x1f\x7f-\x9f]/.test(v)
const faults = new WeakSet()
function fault(code, message) { const error = Object.assign(new Error(message), { code }); faults.add(error); return error }
const fail = error => ({ success: false, code: faults.has(error) ? error.code : 'COMFY_ROUTER_UNAVAILABLE',
  error: faults.has(error) ? error.message : 'Comfy Router could not finish this operation. No automatic retry was made.',
  ...(faults.has(error) && validDiagnostics(error.diagnostics) ? { diagnostics: { ...error.diagnostics } } : {}),
  // Comfy refuses queued requests for older keys that are not tied to a workspace.
  ...(faults.has(error) && error.diagnostics?.errorType === 'not_enabled' ? { queueNotEnabled: true } : {}) })
const invalid = () => fault('COMFY_ROUTER_INVALID', 'Review the Comfy Router request and try again.')
const fingerprint = key => createHash('sha256').update(key).digest('hex')
// The account's credit balance, the same address ComfyUI's own screen reads.
const BALANCE_URL = `${ORIGIN}/customers/balance`
const endpoint = (suffix, model = MODEL) => `${ORIGIN}/v2/models/${model}${suffix}`
// Create requests: a person's click on a button that shows the price approves
// a request up to this amount. Above it, or with no price on record, the native
// confirmation still asks. Agent-initiated requests never use this path.
const BUTTON_APPROVAL_USD = 2
// From the paired phone, a request above the button limit can be approved by a
// second, explicit confirmation of its exact price, up to this much. Above it,
// or with no set price, the request has to be started on the computer.
const PHONE_CONFIRM_MAX_USD = 20
const amount = v => typeof v === 'number' && Number.isFinite(v) && v > 0
const validCreate = v => object(v) && Object.keys(v).every(k => ['modelId', 'usd', 'credits', 'pixels'].includes(k)) && Boolean(getModel(v.modelId))
  && (v.pixels === undefined || exact(v.pixels, ['width', 'height']) && [v.pixels.width, v.pixels.height].every(n => Number.isInteger(n) && n >= 64 && n <= MAX_SIDE))
  && Object.hasOwn(v, 'usd') && (v.usd === null || amount(v.usd)) && (v.credits === undefined || typeof v.credits === 'number' && Number.isFinite(v.credits) && v.credits >= 0 && v.credits < 1e7)
// A live quote is asked for with this stand-in description, so what the person
// wrote is not sent to Comfy until they choose to generate.
const QUOTE_PROMPT = 'A quiet landscape at sunset with soft light.'
// Comfy returns a low and a high amount. When they are this close the high one
// is shown as the price; a wider gap is a range, not a price.
const FIRM_SPREAD = 1.1
const ONE = { image: 'picture', video: 'clip', voice: 'voice recording', sound: 'sound', music: 'piece of music' }
const isAudio = model => AUDIO_KINDS.includes(model.kind)
// A model Comfy only runs on its wait-for-the-result route. Its request is sent
// once, in the background, and the audio it answers with is kept on this
// computer until it is added to the project.
const syncModel = job => Boolean(job?.create) && getModel(job.create.modelId)?.delivery === 'sync'
const SYNC_SETTLED_MS = 15 * 60 * 1000
const AUDIO_MAX = 256 * 1024 * 1024
function priced(model, usd, firm, basis, asOf) {
  const credits = Math.round(usd * catalog.creditsPerUsd * 100) / 100
  return { currency: 'USD', amount: usd, usd, credits, asOf, firm, basis,
    label: `${firm ? 'About' : 'Usually about'} $${usd.toFixed(2)} (${credits} Comfy credits) for one ${ONE[model.kind]}. ${basis === 'live' ? 'Quoted by Comfy' : 'Recorded'} ${asOf}; final provider billing may differ.` }
}
function createEstimate(modelId, choices) {
  const model = getModel(modelId)
  const price = fallbackPrice(modelId, model.kind === 'voice' ? { characters: choices.characters } : isAudio(model) ? { seconds: choices.seconds }
    : model.kind === 'video' ? { seconds: choices.seconds, resolution: choices.resolution } : { size: choices.size, edit: Boolean(choices.hasPicture) })
  // With an input picture the recorded price is for the same request without one, so it is never shown as firm.
  return price ? priced(model, price.usd, price.firm && !choices.hasPicture, price.source, price.asOf) : null
}
// Create pictures come back inline from these formats. The other two (FLUX and
// Seedance) return a signed download link to Comfy's result storage.
const INLINE_FORMATS = new Set(['gemini-image', 'seedream', 'gpt-image'])
// Audio models whose answer is a link to the file, not the file.
const LINKED_AUDIO = new Set(['pika-music'])
// The ONLY place a result link may point. Observed on a real FLUX 3 Image result
// on 2026-11-09. The host is shared by all of Google Cloud Storage, so the bucket
// prefix is part of the rule. A link anywhere else (Comfy's docs say a provider's
// own address can appear when re-hosting fails) is refused, never followed.
const RESULT_STORAGE = Object.freeze({ host: 'storage.googleapis.com', prefix: '/partner-nodes-assets/' })
const VIDEO_MAX = 1024 * 1024 * 1024
// A finished result is collected from whatever address Comfy's answer gives, exactly as ComfyUI does.
// Comfy usually re-hosts results on its own storage (RESULT_STORAGE), but it also hands out the model
// maker's own address, and a result the user paid for must never be left behind because of where it is.
// Only two kinds of link are not followed, and neither can be a real result: one that is not https, and
// one that points back into this computer or its local network.
function localHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (!host || host === 'localhost' || /\.(localhost|local|internal|lan|home)$/.test(host)) return true
  if (host.includes(':')) return host === '::' || host === '::1' || /^(fc|fd|fe[89ab])/.test(host) || host.startsWith('::ffff:')
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!v4) return !host.includes('.')
  const [a, b] = [Number(v4[1]), Number(v4[2])]
  return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31 || a === 100 && b >= 64 && b <= 127
}
function storageLink(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\s\x00-\x1f\\]/.test(value)) return null
  let url
  try { url = new URL(value) } catch { return null }
  return url.protocol === 'https:' && url.username === '' && url.password === '' && !localHost(url.hostname) ? url.href : null
}
// A file that is plainly a message (JSON, HTML, XML) and not media: the only kind of result that is not saved.
function looksLikeText(data) {
  const head = data.subarray(0, 64).toString('latin1').trimStart()
  return !data.length || head.startsWith('<') || head.startsWith('{') || head.startsWith('[')
}
// Any other video container is kept too; an unknown one is saved as it came, under the usual name.
function otherVideo(data) {
  if (looksLikeText(data) || imageHeader(data, () => true)) return null
  if (data.length >= 4 && data.readUInt32BE(0) === 0x1a45dfa3) return { mimeType: 'video/webm', extension: 'webm' }
  if (data.length >= 12 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'AVI ') return { mimeType: 'video/x-msvideo', extension: 'avi' }
  return { mimeType: 'video/mp4', extension: 'mp4' }
}
// A sound of a kind this list does not know is kept as well.
function otherSound(data) { return looksLikeText(data) ? null : { mimeType: 'audio/mpeg', extension: 'mp3' } }
function resultLink(format, result) {
  if (format === 'flux') return result.status === 'Ready' && object(result.result) ? result.result.sample : null
  if (format === 'seedance') return result.status === 'succeeded' && object(result.content) ? result.content.video_url : null
  // Pika answers with the job and, once completed, one audio file behind a link (Comfy's published shape).
  if (format === 'pika-music') return result.status === 'completed' && object(result.output) && result.output.media_type === 'audio' && object(result.output.audio) ? result.output.audio.url : null
  return null
}
// A light check that bytes are a sound file of a kind Velorn can play: MP3, WAV, Ogg, FLAC or M4A.
function audioHeader(data) {
  if (!Buffer.isBuffer(data) || data.length < 128) return null
  const tag = data.toString('latin1', 0, 4)
  if (tag === 'RIFF' && data.toString('latin1', 8, 12) === 'WAVE') return { mimeType: 'audio/wav', extension: 'wav' }
  if (tag === 'OggS') return { mimeType: 'audio/ogg', extension: 'ogg' }
  if (tag === 'fLaC') return { mimeType: 'audio/flac', extension: 'flac' }
  if (data.toString('latin1', 4, 8) === 'ftyp' && /^(M4A |M4B |mp42|isom|dash)$/.test(data.toString('latin1', 8, 12))) return { mimeType: 'audio/mp4', extension: 'm4a' }
  // MP3: an ID3 tag, or a frame header (sync bits, layer III, a real bitrate and sample rate).
  if (tag.startsWith('ID3') && data[3] < 0xff && data[4] < 0xff) return { mimeType: 'audio/mpeg', extension: 'mp3' }
  if (data[0] === 0xff && (data[1] & 0xe6) === 0xe2 && (data[2] & 0xf0) !== 0xf0 && (data[2] & 0xf0) !== 0 && (data[2] & 0x0c) !== 0x0c) return { mimeType: 'audio/mpeg', extension: 'mp3' }
  return null
}
// A light container check: an ISO media file (mp4 or mov) starts with an `ftyp` box.
function videoHeader(data) {
  if (data.length < 4096 || data.toString('ascii', 4, 8) !== 'ftyp') return null
  const size = data.readUInt32BE(0)
  if (size < 16 || size > 4096 || size > data.length) return null
  const brand = data.toString('ascii', 8, 12)
  if (!/^[a-zA-Z0-9 ]{4}$/.test(brand)) return null
  return brand === 'qt  ' ? { mimeType: 'video/quicktime', extension: 'mov' } : { mimeType: 'video/mp4', extension: 'mp4' }
}
const MAX_SIDE = 4096
function inlinePicture(format, result) {
  if (format === 'gemini-image') {
    const candidates = Array.isArray(result.candidates) ? result.candidates : []
    // One request asks for one picture. If the model sends more, the first is kept rather than none.
    const parts = candidates.flatMap(candidate => Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [])
    const pictures = parts.filter(part => object(part) && object(part.inlineData) && typeof part.inlineData.data === 'string')
    return pictures.length ? pictures[0].inlineData.data : null
  }
  return Array.isArray(result.data) && result.data.length ? result.data[0]?.b64_json : null
}
function expectedPixels(format, body) {
  const match = format !== 'gemini-image' && /^(\d{2,4})x(\d{2,4})$/.exec(body?.size || '')
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null
}
const secretLike = (prompt, credential) => /\x00/.test(prompt)
  || /(?:\bsk-[a-z0-9_-]{16,}|\bBearer\s+\S{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i.test(prompt) || prompt.includes(credential)
const safeErrorType = value => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(value) ? value : 'PROVIDER_FAILED'
const ERROR_TYPES = new Set(['invalid_input', 'content_policy_violation', 'provider_error', 'provider_timeout', 'insufficient_credits',
  'model_not_found', 'unauthorized', 'forbidden', 'concurrency_limit_exceeded', 'client_disconnected', 'internal_error', 'deadline_exceeded',
  'not_enabled', 'service_unavailable', 'rate_limited', 'cancelled', 'queue_timeout', 'request_not_found', 'queue_backlog_full'])
const supportId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
function validDiagnostics(value) {
  return object(value) && Object.keys(value).every(key => ['httpStatus', 'errorType', 'requestId'].includes(key))
    && Number.isInteger(value.httpStatus) && value.httpStatus >= 400 && value.httpStatus <= 599
    && (value.errorType === undefined || ERROR_TYPES.has(value.errorType))
    && (value.requestId === undefined || supportId(value.requestId))
}
function responseDiagnostics(response, key) {
  const httpStatus = response?.status
  if (!Number.isInteger(httpStatus) || httpStatus < 400 || httpStatus > 599) return undefined
  const errorType = response.headers?.get?.('x-comfy-error-type')
  const requestId = response.headers?.get?.('x-comfy-request-id')
  // Never retain raw error bodies or arbitrary header strings. A support ID
  // is diagnostic correlation only, NOT an admitted/pollable provider job ID.
  return { httpStatus, ...(ERROR_TYPES.has(errorType) && errorType !== key ? { errorType } : {}),
    ...(supportId(requestId) && requestId.toLowerCase() !== String(key).toLowerCase() ? { requestId } : {}) }
}
function diagnosticMessage(diagnostics) {
  const status = diagnostics?.httpStatus, type = diagnostics?.errorType
  let message = 'Comfy Router could not complete this request.'
  if (status === 401) message = 'Comfy Router rejected the credential. Enter a valid Comfy key in the private field.'
  else if (type === 'not_enabled') message = 'Queued Router generation is not enabled for this key or model. Check that the key belongs to a Comfy workspace and that the model supports queued requests.'
  else if (type === 'content_policy_violation') message = 'The provider reported a content-policy rejection. Review the prompt before another generation attempt.'
  else if (type === 'insufficient_credits' || status === 402) message = 'Comfy reports insufficient workspace credits. Check the balance of the workspace tied to this key; Velorn did not purchase credits.'
  else if (status === 403) message = 'Comfy denied access to this operation. Check the key’s workspace and model permissions; a catalog connection check does not verify generation access.'
  else if (type === 'model_not_found') message = 'Comfy could not find the requested model. Check its current availability before another generation attempt.'
  else if (status === 409) message = 'Comfy reported a request conflict. Inspect the existing request before trying again; a new submission could be billed separately.'
  else if (type === 'invalid_input' || status === 422 || status === 400) message = 'Comfy rejected the request parameters. The prompt or model settings need review before another generation attempt.'
  else if (status === 429) message = 'Comfy reported a request or concurrency limit. Wait and check workspace limits before another attempt.'
  else if (status === 404 || status === 410) message = 'Comfy could not retrieve this model or request. A completed result may no longer be available.'
  else if (status >= 500) message = 'Comfy reported a service or provider error. Submission or billing may still be uncertain; inspect the existing request before another attempt.'
  const details = status ? ` (HTTP ${status}${type ? ` · ${type}` : ''})` : ''
  return `${message}${details} No automatic retry was made.`
}
const rejectedSubmission = job => job.status === 'FAILED' && job.errorType === 'REQUEST_REJECTED' && !job.providerJobId
const stoppedBeforeSubmission = job => job.status === 'CANCELLED' && job.errorType === 'NOT_SUBMITTED' && !job.providerJobId
const NOT_SUBMITTED_MESSAGE = 'This request was stopped before submission. No generation request was sent, and there is no provider job to refresh.'
function submissionErrorMessage(job) {
  if (validDiagnostics(job.diagnostics)) return diagnosticMessage(job.diagnostics)
  return 'Comfy rejected this earlier submission before returning a generation job ID. The earlier Velorn version did not retain the detailed rejection reason. There is no accepted job to refresh; no retry was made.'
}

// Bound declared pixel allocation BEFORE a codec sees untrusted compressed
// bytes. This is not a substitute for the native decoder verification below.
function imageHeader(data, correct = (width, height) => width === WIDTH && height === HEIGHT) {
  if (data.length >= 33 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (data.readUInt32BE(8) !== 13 || data.toString('ascii', 12, 16) !== 'IHDR' || !correct(data.readUInt32BE(16), data.readUInt32BE(20))) return null
    let offset = 8, chunks = 0, pixels = false
    while (offset + 12 <= data.length && ++chunks <= 4096) {
      const size = data.readUInt32BE(offset), type = data.toString('ascii', offset + 4, offset + 8)
      if (size > data.length - offset - 12 || type === 'IHDR' && offset !== 8 || ['acTL', 'fcTL', 'fdAT'].includes(type)) return null
      if (type === 'IDAT') pixels = true
      offset += size + 12
      if (type === 'IEND') return size === 0 && offset === data.length && pixels ? { mimeType: 'image/png', extension: 'png' } : null
    }
    return null
  }
  if (data.length >= 4 && data[0] === 255 && data[1] === 216) {
    let offset = 2, segments = 0, dimensions = false
    const frames = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
    while (offset < data.length && offset <= 1024 * 1024 && ++segments <= 512) {
      if (data[offset++] !== 255) return null
      while (data[offset] === 255) offset++
      if (offset >= data.length) return null
      const marker = data[offset++]
      if (marker === 0xda) return dimensions ? { mimeType: 'image/jpeg', extension: 'jpg' } : null
      if (marker === 0xd9 || marker === 0 || marker === 0xd8 || marker >= 0xd0 && marker <= 0xd7 || offset + 2 > data.length) return null
      if (marker === 0x01) continue
      const length = data.readUInt16BE(offset)
      if (length < 2 || length > data.length - offset) return null
      if (frames.has(marker)) {
        if (dimensions || length < 8 || !correct(data.readUInt16BE(offset + 5), data.readUInt16BE(offset + 3))) return null
        dimensions = true
      }
      offset += length
    }
    return null
  }
  if (data.length >= 20 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
    if (data.readUInt32LE(4) + 8 !== data.length) return null
    let offset = 12, chunks = 0, picture = false, extended = false
    while (offset + 8 <= data.length && ++chunks <= 1024) {
      const type = data.toString('ascii', offset, offset + 4), size = data.readUInt32LE(offset + 4), start = offset + 8
      if (size > data.length - start || ['ANIM', 'ANMF'].includes(type)) return null
      if (type === 'VP8X') {
        if (extended || offset !== 12 || size !== 10 || data[start] & 0x02 || !correct(data.readUIntLE(start + 4, 3) + 1, data.readUIntLE(start + 7, 3) + 1)) return null
        extended = true
      } else if (type === 'VP8 ') {
        if (picture || size < 10 || data[start] & 1 || !data.subarray(start + 3, start + 6).equals(Buffer.from([157, 1, 42]))
          || !correct(data.readUInt16LE(start + 6) & 0x3fff, data.readUInt16LE(start + 8) & 0x3fff)) return null
        picture = true
      } else if (type === 'VP8L') {
        if (picture || size < 5 || data[start] !== 0x2f) return null
        const bits = data.readUInt32LE(start + 1)
        if (bits >>> 29 || !correct((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)) return null
        picture = true
      }
      offset = start + size + (size % 2)
      if (offset > data.length) return null
    }
    return picture && offset === data.length ? { mimeType: 'image/webp', extension: 'webp' } : null
  }
  return null
}

function createComfyRouter({ fetchImpl = globalThis.fetch, storageDir, getContext, getPolicy, confirmSpend, validateImage, notify = () => {},
  now = Date.now, timeoutMs = LIMITS.timeoutMs, keyStore = null, syncTimeoutMs = 11 * 60 * 1000, allowPending = false,
  // A fresh whole number for each picture request. Tests pass their own.
  newSeed = () => randomInt(1, 2147483647) } = {}) {
  if (!path.isAbsolute(storageDir || '') || typeof getContext !== 'function' || typeof getPolicy !== 'function') throw new TypeError('Router requires private storage and native context/policy dependencies.')
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > LIMITS.timeoutMs) throw new TypeError('Invalid Router timeout.')
  const ledgerFile = path.join(storageDir, 'comfy-router-jobs.json')
  let credential = '', credentialId = '', disposed = false, version = 0, initialized = null, writeQueue = Promise.resolve(), busySubmit = false
  // `remembered` is true only while the key in use is also in the OS-protected store.
  let remembered = false, keyEpoch = 0
  const canRemember = () => { try { return Boolean(keyStore) && keyStore.canRemember() === true } catch { return false } }
  const jobs = new Map(), plans = new Map(), operations = new Set(), refreshAfter = new Map()
  // Wait-for-the-result requests that are still out. They outlive the call that started them.
  const background = new Set()
  const resultFile = job => path.join(storageDir, `result-${job.id}.audio`)
  // Which requests were started from the paired phone. Kept beside the job
  // record, not inside it, so an older Velorn sharing this data folder can still
  // read the record. Losing this file only means those results wait for the
  // Create tab's own pick-up instead of being saved to the project by themselves.
  const phoneFile = path.join(storageDir, 'comfy-router-phone-jobs.json')
  const phoneJobs = new Set()
  async function loadPhoneJobs() {
    try {
      const listed = JSON.parse(await fs.readFile(phoneFile, 'utf8'))
      if (Array.isArray(listed) && listed.length <= LIMITS.jobs) for (const id of listed) if (identifier(id) && jobs.has(id)) phoneJobs.add(id)
    } catch { /* No list, or an unreadable one: nothing is marked. */ }
  }
  async function savePhoneJobs() {
    for (const id of phoneJobs) if (!jobs.has(id)) phoneJobs.delete(id)
    const temporary = path.join(storageDir, `.comfy-router-phone-${randomUUID()}.tmp`)
    try { await fs.writeFile(temporary, JSON.stringify([...phoneJobs]), { mode: 0o600, flag: 'wx' }); await fs.rename(temporary, phoneFile) }
    catch { await fs.unlink(temporary).catch(() => {}) }
  }

  function live(op) {
    if (disposed || op.version !== version || op.controller.signal.aborted) throw fault('COMFY_ROUTER_CANCELLED', 'The Router operation stopped. Submitted work may still run and spend credits; refresh its status before trying again.')
  }
  async function abortable(op, operation) {
    live(op)
    let listener
    const aborted = new Promise((_, reject) => {
      listener = () => reject(fault('COMFY_ROUTER_CANCELLED', 'The Router operation stopped. A submitted job may still run; refresh its status before trying again.'))
      op.controller.signal.addEventListener('abort', listener, { once: true })
    })
    try { return await Promise.race([Promise.resolve().then(() => { live(op); return operation() }), aborted]) }
    finally { op.controller.signal.removeEventListener('abort', listener) }
  }
  async function context(op, projectRequired = true) {
    const timer = setTimeout(() => op.controller.abort('context-timeout'), 5000)
    let value
    try { value = await abortable(op, getContext); live(op) }
    finally { clearTimeout(timer) }
    if (!object(value) || typeof value.session !== 'string' || !value.session || value.session.length > 512
      || !(value.projectKey == null || typeof value.projectKey === 'string' && value.projectKey.length <= 8192)
      || projectRequired && !value.projectKey) throw fault('COMFY_ROUTER_PROJECT_REQUIRED', 'Open or save a Velorn project before generating an image.')
    return { session: value.session, projectKey: value.projectKey || null }
  }
  async function check(op, projectRequired = true) {
    live(op)
    const current = await context(op, projectRequired)
    if (op.context && (current.session !== op.context.session || current.projectKey !== op.context.projectKey)) throw fault('COMFY_ROUTER_STALE_CONTEXT', 'The project or window changed. Return to the original project to inspect this job.')
    live(op)
  }
  async function policy(op, projectRequired = true) {
    const result = await abortable(op, getPolicy); await check(op, projectRequired)
    return typeof result === 'string' ? result : result?.policy
  }
  function begin() { const op = { controller: new AbortController(), version, context: null }; operations.add(op); return op }
  async function perform(payload, keys, work, projectRequired = true) {
    if (!exact(payload, keys)) return fail(invalid())
    const op = begin()
    try {
      live(op); await initialize(); live(op)
      op.context = await context(op, projectRequired)
      const value = await work(op); await check(op, projectRequired)
      return value
    } catch (error) { return fail(error) }
    finally { operations.delete(op); op.controller.abort() }
  }
  function announce(job) { try { notify({ jobId: job.id, projectKey: job.projectKey, status: job.status }) } catch {} }
  function view(job) {
    const created = job.create ? getModel(job.create.modelId) : null
    return { jobId: job.id, ...(created
        ? { model: job.model, modelLabel: created.name, modelId: created.id, kind: created.kind, create: true, estimateUsd: job.create.usd,
          ...(job.create.credits !== undefined ? { chargedCredits: job.create.credits, chargedUsd: Math.round(job.create.credits / catalog.creditsPerUsd * 10000) / 10000 } : {}) }
        : { model: MODEL, modelLabel: MODEL_LABEL, width: WIDTH, height: HEIGHT, estimate: ESTIMATE }), status: job.status,
      createdAt: job.createdAt, updatedAt: job.updatedAt,
      ...(job.errorType ? { errorType: job.errorType } : {}), ...(job.importedAssetId ? { importedAssetId: job.importedAssetId } : {}),
      ...(phoneJobs.has(job.id) ? { fromPhone: true } : {}),
      ...(validDiagnostics(job.diagnostics) ? { diagnostics: { ...job.diagnostics } } : {}),
      ...(rejectedSubmission(job) ? { submissionRejected: true, errorMessage: submissionErrorMessage(job) } : {}),
      ...(stoppedBeforeSubmission(job) ? { notSubmitted: true, errorMessage: NOT_SUBMITTED_MESSAGE } : {}),
      // A wait-for-the-result request has nothing to ask Comfy about; once it is done its audio is on this computer.
      canRefresh: Boolean(job.providerJobId) || syncModel(job) && job.status === 'COMPLETED',
      needsReconnect: Boolean(job.providerJobId) && credentialId !== job.credentialFingerprint,
      outputAvailable: job.status === 'COMPLETED', cancellationRequested: job.cancelState === 'REQUESTED',
      ...(job.cancelState ? { cancellationState: job.cancelState } : {}),
      retryAfterMs: Math.max(0, (refreshAfter.get(job.id) || 0) - now()) }
  }
  function validRecord(v) {
    const allowed = ['id', 'projectKey', 'credentialFingerprint', 'model', 'status', 'createdAt', 'updatedAt', 'providerJobId', 'errorType', 'cancelState', 'importedAssetId', 'diagnostics', 'create']
    return object(v) && Object.keys(v).every(k => allowed.includes(k)) && identifier(v.id) && typeof v.projectKey === 'string' && v.projectKey.length > 0 && v.projectKey.length <= 8192
      && /^[a-f0-9]{64}$/.test(v.credentialFingerprint) && (v.create === undefined ? v.model === MODEL : validCreate(v.create) && getModel(v.create.modelId).model === v.model) && STATES.has(v.status)
      && Number.isSafeInteger(v.createdAt) && Number.isSafeInteger(v.updatedAt)
      && (v.providerJobId === undefined || identifier(v.providerJobId)) && (v.errorType === undefined || safeErrorType(v.errorType) === v.errorType)
      && (v.cancelState === undefined || ['PENDING', 'REQUESTED', 'UNCERTAIN'].includes(v.cancelState))
      && (v.importedAssetId === undefined || identifier(v.importedAssetId))
      && (v.diagnostics === undefined || validDiagnostics(v.diagnostics))
  }
  function initialize() {
    if (initialized) return initialized
    initialized = (async () => {
      await fs.mkdir(storageDir, { recursive: true, mode: 0o700 })
      const dir = await fs.lstat(storageDir)
      if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error('Invalid ledger directory')
      let handle
      try {
        handle = await fs.open(ledgerFile, fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW || 0))
        const stat = await handle.stat()
        if (!stat.isFile() || stat.size > LIMITS.ledger) throw new Error('Invalid ledger')
        const bytes = Buffer.alloc(LIMITS.ledger + 1); let length = 0
        while (length < bytes.length) { const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null); if (!bytesRead) break; length += bytesRead }
        if (length > LIMITS.ledger) throw new Error('Invalid ledger')
        const parsed = JSON.parse(bytes.subarray(0, length).toString('utf8'))
        if (!exact(parsed, ['version', 'jobs']) || parsed.version !== 1 || !Array.isArray(parsed.jobs) || parsed.jobs.length > LIMITS.jobs || !parsed.jobs.every(validRecord)) throw new Error('Invalid ledger')
        for (const record of parsed.jobs) {
          if (jobs.has(record.id)) throw new Error('Duplicate ledger job')
          jobs.set(record.id, { ...record, status: record.status === 'SUBMITTING' ? 'UNCERTAIN' : record.status,
            ...(record.cancelState === 'PENDING' ? { cancelState: 'UNCERTAIN' } : {}) })
        }
      } catch (error) { if (error?.code !== 'ENOENT') throw fault('COMFY_ROUTER_LEDGER', 'The local Router job record could not be read. Do not resubmit uncertain work; inspect your Comfy account first.') }
      finally { await handle?.close() }
      await loadPhoneJobs()
      // Bring back a remembered key once per launch. It is not sent anywhere here;
      // Comfy judges it the first time it is used. A connect or forget that
      // happened while the store was being read wins over what was stored.
      if (canRemember()) {
        const epoch = keyEpoch
        let stored = ''
        try { stored = await keyStore.load() } catch {}
        if (validKey(stored) && epoch === keyEpoch && !credential && !disposed) { credential = stored; credentialId = fingerprint(stored); remembered = true }
      }
    })()
    return initialized
  }
  function persist() {
    const run = writeQueue.then(async () => {
      const serialized = JSON.stringify({ version: 1, jobs: [...jobs.values()] })
      if (Buffer.byteLength(serialized) > LIMITS.ledger) throw new Error('Ledger full')
      const temporary = path.join(storageDir, `.comfy-router-${randomUUID()}.tmp`)
      let handle, renamed = false
      try {
        handle = await fs.open(temporary, 'wx', 0o600)
        await handle.writeFile(serialized); await handle.sync(); await handle.close(); handle = null
        fsSync.renameSync(temporary, ledgerFile); renamed = true
      } finally { await handle?.close(); if (!renamed) await fs.unlink(temporary).catch(() => {}) }
    })
    writeQueue = run.catch(() => {})
    return run
  }
  function needCredential(job) {
    if (!credential || job && job.credentialFingerprint !== credentialId) throw fault('COMFY_ROUTER_KEY_REQUIRED', job ? 'Reconnect the same Comfy Router key used for this job before checking it.' : 'Connect a Comfy Router key in the private field first.')
  }
  function owned(op, id) {
    if (!identifier(id)) throw invalid()
    const job = jobs.get(id)
    if (!job || job.projectKey !== op.context.projectKey) throw fault('COMFY_ROUTER_JOB_NOT_FOUND', 'This job does not belong to the active project.')
    return job
  }
  async function bytes(response, op, maximum) {
    if (Number(response.headers?.get?.('content-length')) > maximum || !response.body?.getReader) throw fault('COMFY_ROUTER_RESPONSE', 'The provider response could not be verified.')
    const reader = response.body.getReader(), chunks = []; let length = 0
    try {
      while (true) {
        const item = await abortable(op, () => reader.read()); live(op)
        if (item.done) break
        length += item.value.byteLength
        if (length > maximum) throw fault('COMFY_ROUTER_RESPONSE', 'The provider response exceeded the allowed size.')
        chunks.push(Buffer.from(item.value))
      }
      return Buffer.concat(chunks)
    } finally { try { await reader.cancel() } catch {} }
  }
  async function request(op, url, { method = 'GET', key = credential, body, idempotency, resultBody = false } = {}) {
    if (typeof fetchImpl !== 'function') throw fault('COMFY_ROUTER_UNAVAILABLE', 'Comfy Router transport is unavailable. Restart Velorn.')
    await check(op, Boolean(op.context.projectKey))
    const timer = setTimeout(() => op.controller.abort('timeout'), timeoutMs)
    try {
      const response = await abortable(op, () => fetchImpl(url, { method, redirect: 'error', credentials: 'omit', cache: 'no-store', signal: op.controller.signal,
        headers: { ...(key ? { 'X-API-Key': key } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(idempotency ? { 'Idempotency-Key': idempotency } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) }))
      await check(op, Boolean(op.context.projectKey))
      if (!response?.ok) {
        const diagnostics = responseDiagnostics(response, key)
        try { await response?.body?.cancel?.() } catch {}
        const error = fault(response?.status === 401 ? 'COMFY_ROUTER_AUTH' : response?.status === 402 || response?.status === 403 ? 'COMFY_ROUTER_ACCESS' : 'COMFY_ROUTER_PROVIDER',
          diagnosticMessage(diagnostics))
        if (diagnostics) error.diagnostics = diagnostics
        error.definiteRejection = response?.status >= 400 && response?.status < 500 && ![408, 409].includes(response?.status)
        throw error
      }
      const content = await bytes(response, op, resultBody ? LIMITS.result : LIMITS.response)
      await check(op, Boolean(op.context.projectKey))
      op.responseStatus = response.status
      const used = response.headers?.get?.('x-comfy-credits-used')
      op.creditsUsed = /^\d{1,7}(?:\.\d{1,6})?$/.test(used || '') ? Number(used) : undefined
      const retry = response.headers?.get?.('retry-after')
      const delay = /^\d+(?:\.\d+)?$/.test(retry || '') ? Number(retry) * 1000 : Date.parse(retry) - now()
      op.retryAfterMs = Number.isFinite(delay) && delay > 0 && delay < Number.MAX_SAFE_INTEGER - now() ? Math.max(1000, Math.ceil(delay)) : 1000
      const parsed = JSON.parse(content.toString('utf8'))
      if (!object(parsed)) throw new Error('Invalid response')
      return parsed
    } finally { clearTimeout(timer) }
  }
  function stop() {
    version++
    for (const op of operations) op.controller.abort()
    // Ending an agent turn cancels its outstanding work, not the idle preview
    // the user may approve in their next turn. Plans still have native-owned
    // session/project/key bindings and an expiry; navigation cannot rebind one.
  }
  function status(payload = {}) { return perform(payload, [], async op => {
    const currentPolicy = await policy(op, false)
    return { success: true, configured: Boolean(credential), keyAccepted: Boolean(credential), model: MODEL,
      modelLabel: MODEL_LABEL, width: WIDTH, height: HEIGHT, estimate: ESTIMATE, sessionOnly: !remembered, remembered, canRemember: canRemember(),
      policy: ['local-only', 'ask-cloud'].includes(currentPolicy) ? currentPolicy : 'unavailable',
      summary: remembered ? 'A Comfy Router key is remembered on this computer, encrypted by the system password store. Workspace access, credits and generation have not been verified.'
        : credential ? 'Comfy Router accepted this session key for model access. Workspace access, credits and generation have not been verified.'
        : canRemember() ? 'Connect a Comfy Router key privately. It will be remembered on this computer, encrypted by the system password store.'
        : 'Connect a Comfy Router key privately. It is kept only for this Velorn session.' }
  }, false) }
  // The Create list for the screen: names, choices and recorded prices. No key,
  // project or network is needed to read it.
  // How many Comfy credits the connected key's account has left, for the figure at the top of the window.
  // Read only: nothing is charged and no model runs. The key never leaves this process; the window gets a number.
  // `known: false` covers every way of not knowing (no key, Comfy does not say, an answer in another shape).
  function balance(payload = {}) { return perform(payload, [], async op => {
    if (!credential) return { success: true, connected: false, known: false }
    let reply
    try { reply = await request(op, BALANCE_URL) }
    catch (error) { if (faults.has(error) && ['COMFY_ROUTER_AUTH', 'COMFY_ROUTER_ACCESS', 'COMFY_ROUTER_PROVIDER'].includes(error.code)) return { success: true, connected: true, known: false }; throw error }
    // Comfy names these fields "micros" but they hold US cents (as ComfyUI's own screen reads them).
    const cents = [reply.effective_balance_micros, reply.amount_micros].find(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 1e12)
    if (cents === undefined || (reply.currency !== undefined && String(reply.currency).toLowerCase() !== 'usd')) return { success: true, connected: true, known: false }
    return { success: true, connected: true, known: true, credits: Math.round(cents / 100 * catalog.creditsPerUsd * 100) / 100, usd: Math.round(cents) / 100 }
  }, false) }
  function models(payload = {}) { return perform(payload, [], async () => ({ success: true, pricesAsOf: catalog.pricesAsOf, buttonApprovalUsd: BUTTON_APPROVAL_USD, creditsPerUsd: catalog.creditsPerUsd,
    voices: listVoices({ unverified: allowPending }).map(v => ({ id: v.id, name: v.name, note: v.note })),
    models: listModels().filter(m => allowPending || !m.pending).map(m => ({ id: m.id, kind: m.kind, name: m.name, note: m.note, default: m.default === true, refusalCharged: m.refusalCharged,
      firmQuote: m.quote === 'firm', editQuote: m.editQuote !== false,
      // A voice model from another provider lists its own voices; the others use the shared list above.
      ...(m.kind === 'voice' ? { characters: { ...m.characters }, usdPer1kCharacters: m.usdPer1kCharacters,
          ...(m.voices ? { voices: listVoices({ unverified: allowPending, model: m }).map(v => ({ id: v.id, name: v.name, note: v.note })) } : {}) }
        : isAudio(m) ? { seconds: { ...m.seconds, offered: [...m.seconds.offered] }, usdPerAudioSecond: m.usdPerAudioSecond, ...(m.lyrics ? { lyrics: { max: m.lyrics.max } } : {}) }
        : m.kind === 'video' ? { seconds: { ...m.seconds, offered: [...m.seconds.offered] }, resolutions: resolutionsFor(m), usdPerSecond: { ...m.usdPerSecond } }
        : { sizes: sizesFor(m), usdPerImage: { ...m.usdPerImage } }) })) }), false) }
  function connect(payload) { return perform(payload, ['apiKey'], async op => {
    if (!validKey(payload.apiKey)) throw invalid()
    await request(op, endpoint(''), { key: payload.apiKey }); await check(op, false)
    // Do not abort this operation; invalidate other plans only after validation.
    for (const other of operations) if (other !== op) other.controller.abort()
    plans.clear(); credential = payload.apiKey; credentialId = fingerprint(credential); remembered = false
    const epoch = ++keyEpoch
    // Remember the accepted key when this computer can protect it. A failed or
    // unavailable store never blocks the connection; the key just stays session-only.
    let stored = false
    if (canRemember()) { try { stored = await keyStore.save(payload.apiKey) === true } catch { stored = false } }
    if (epoch !== keyEpoch || credential !== payload.apiKey) {
      // The key was changed or forgotten while it was being written: do not leave the old one behind.
      if (stored && !credential) { try { await keyStore.forget() } catch {} }
    } else remembered = stored
    return { success: true, configured: true, keyAccepted: true, sessionOnly: !remembered, remembered, model: MODEL,
      summary: remembered ? 'Comfy Router accepted the key. It is remembered on this computer, encrypted by the system password store, until you forget it.'
        : 'Comfy Router accepted the key for model access. Workspace access and available credits will be checked only when you explicitly submit a job.' }
  }, false) }
  function clear(payload) { return perform(payload, [], async op => {
    for (const other of operations) if (other !== op) other.controller.abort()
    credential = ''; credentialId = ''; plans.clear(); remembered = false; keyEpoch++
    if (keyStore) {
      try { await keyStore.forget() }
      catch { throw fault('COMFY_ROUTER_KEY_STORE', 'The key was forgotten for this session, but the remembered copy on this computer could not be removed. Try Forget key again.') }
    }
    return { success: true, configured: false, summary: 'The Router key was forgotten on this computer. Existing provider jobs were not cancelled or deleted.' }
  }, false) }
  function planView(planId, plan, spendingPolicy) {
    if (plan.create) {
      const { model, choices, estimate } = plan.create
      const buttonApproval = Boolean(estimate) && estimate.usd <= BUTTON_APPROVAL_USD
      return { success: true, planId, create: true, model: model.model, modelLabel: model.name, modelId: model.id, kind: model.kind,
        prompt: plan.prompt, choices: { ...choices }, count: plan.create.count, estimate, refusalCharged: model.refusalCharged,
        policy: spendingPolicy, buttonApproval, requiresNativeApproval: !buttonApproval, previewOnly: true,
        ...(plan.jobId ? { job: view(jobs.get(plan.jobId)) } : {}),
        summary: plan.jobId ? 'This exact preview already has a recorded job. Submitting it again will not queue another request.'
          : `${plan.create.count === 1 ? 'One' : plan.create.count} cloud ${plan.create.count === 1 ? ONE[model.kind] : 'pictures, each its own request'}. No request has been queued and no credits have been spent.` }
    }
    return { success: true, planId, model: MODEL, modelLabel: MODEL_LABEL, prompt: plan.prompt, width: WIDTH, height: HEIGHT, estimate: ESTIMATE,
      policy: spendingPolicy, requiresNativeApproval: true, previewOnly: true,
      ...(plan.jobId ? { job: view(jobs.get(plan.jobId)) } : {}),
      summary: plan.jobId ? 'This exact preview already has a recorded job. Submitting it again will not queue another image.' : 'One cloud image. No request has been queued and no credits have been spent.' }
  }
  function checkedPlan(op, planId) {
    const plan = plans.get(planId)
    if (!identifier(planId) || !plan || plan.context.session !== op.context.session || plan.context.projectKey !== op.context.projectKey || plan.credentialId !== credentialId) throw fault('COMFY_ROUTER_PLAN_INVALID', 'Create a fresh preview for the current project and Router key.')
    if (!plan.jobId && now() - plan.createdAt > LIMITS.planMs) throw fault('COMFY_ROUTER_PLAN_EXPIRED', 'The preview expired. Review a new preview before spending credits.')
    needCredential()
    return plan
  }
  // Native agent-host review only. The public renderer bridge does not need
  // access to another prompt-bearing plan getter.
  function inspectPlan(payload) { return perform(payload, ['planId'], async op => {
    const plan = checkedPlan(op, payload.planId)
    const spendingPolicy = await policy(op)
    if (plans.get(payload.planId) !== plan) throw fault('COMFY_ROUTER_PLAN_INVALID', 'The preview changed. Review a fresh preview.')
    return planView(payload.planId, plan, spendingPolicy)
  }) }
  function preview(payload) { return perform(payload, ['prompt'], async op => {
    needCredential()
    if (typeof payload.prompt !== 'string' || !payload.prompt.trim() || payload.prompt.length > LIMITS.prompt || secretLike(payload.prompt, credential)) throw invalid()
    // Expiring a RAM preview never removes its durable job. A pruned plan ID
    // fails closed on submit; it cannot create or retry the recorded job.
    for (const [id, plan] of plans) if (now() - plan.createdAt > LIMITS.planMs) plans.delete(id)
    if (plans.size >= LIMITS.plans) throw fault('COMFY_ROUTER_PLAN_LIMIT', 'Too many recent previews. Wait for an older preview to expire (previews last 10 minutes), then create another. Existing jobs remain recorded.')
    const planId = randomUUID()
    const plan = { context: { ...op.context }, credentialId, prompt: payload.prompt.trim(), createdAt: now(), jobId: null }
    plans.set(planId, plan)
    return planView(planId, plan, await policy(op))
  }) }
  // Asks Comfy what one request would cost. Free, runs no model, and carries a
  // stand-in description. Falls back to the recorded price when Comfy cannot be
  // asked, and to no price when Comfy's answer and the record disagree.
  async function quote(op, model, choices, spendingPolicy) {
    const recorded = createEstimate(model.id, choices)
    // A quote for a request with a picture would mean sending the picture before
    // the person chose to generate, so the recorded price stands in.
    if (spendingPolicy !== 'ask-cloud' || choices.hasPicture) return recorded
    let reply
    try {
      // Speech is priced on its length, so the stand-in is filler of the same length.
      const { characters, ...asked } = choices
      const standIn = model.kind === 'voice' ? 'la '.repeat(Math.ceil(characters / 3)).slice(0, characters).replace(/ $/, 'a') : QUOTE_PROMPT
      // Lyrics are the person's own words too: the price check carries filler of the same length.
      if (asked.lyrics) asked.lyrics = 'la '.repeat(Math.ceil(asked.lyrics.length / 3)).slice(0, asked.lyrics.length).replace(/ $/, 'a')
      reply = await request(op, endpoint('/estimate', model.model), { method: 'POST', body: buildCreateRequest(model.id, { ...asked, prompt: standIn }).body })
    } catch (error) {
      if (faults.has(error) && !['COMFY_ROUTER_PROVIDER', 'COMFY_ROUTER_ACCESS'].includes(error.code)) throw error
      await check(op)
      return recorded
    }
    const low = Number(reply.min_amount), high = Number(reply.max_amount)
    if (reply.currency !== 'USD' || typeof reply.min_amount !== 'string' || typeof reply.max_amount !== 'string'
      || !Number.isFinite(low) || low < 0 || !amount(high) || high < low || high > 10000) return recorded
    const asOf = /^\d{4}-\d{2}-\d{2}/.test(reply.pricing_as_of || '') ? reply.pricing_as_of.slice(0, 10) : new Date(now()).toISOString().slice(0, 10)
    if (high <= low * FIRM_SPREAD) return priced(model, high, true, 'live', asOf)
    return recorded && recorded.usd >= low && recorded.usd <= high ? { ...recorded, range: { low, high } } : null
  }
  // A Create preview: any model from the Create list, with the person's choices.
  // Like `preview`, it only prepares a plan; no model runs and nothing is charged.
  // `count` asks for several pictures from one click. Each is still its own
  // request with its own record; the plan's price and approval cover them all.
  // Read only the header: the declared type must match, and the size must be one every model accepts.
  function checkPictureHeader(picture) {
    const data = Buffer.from(picture.base64, 'base64')
    const header = data.toString('base64') === picture.base64
      ? imageHeader(data, (width, height) => width >= 256 && height >= 256 && width <= 8192 && height <= 8192 && width * height <= 16000000) : null
    if (!header || header.mimeType !== picture.mimeType) throw fault('COMFY_ROUTER_INVALID', 'The picture could not be read, or it is smaller than 256 pixels or larger than 16 megapixels.')
  }
  function previewCreate(payload) { return perform(payload, payload && Object.hasOwn(payload, 'count') ? ['modelId', 'choices', 'count'] : ['modelId', 'choices'], async op => {
    needCredential()
    const count = payload.count === undefined ? 1 : payload.count
    if (![1, 2, 4].includes(count)) throw invalid()
    let built
    try { built = buildCreateRequest(payload.modelId, payload.choices) }
    catch (error) { throw error?.code === 'CREATE_REQUEST_INVALID' ? fault('COMFY_ROUTER_INVALID', error.message) : error }
    if (secretLike(built.choices.prompt, credential) || built.choices.lyrics && secretLike(built.choices.lyrics, credential)) throw invalid()
    if (count > 1 && built.model.kind !== 'image') throw fault('COMFY_ROUTER_INVALID', 'Only pictures can be made several at a time.')
    if (!allowPending && (built.model.pending || built.choices.voice && !getVoice(built.choices.voice, built.model).verified)) throw fault('COMFY_ROUTER_INVALID', 'That model or voice is not available yet.')
    for (const picture of [built.picture, ...(built.pictures || [])]) if (picture) checkPictureHeader(picture)
    for (const [id, plan] of plans) if (now() - plan.createdAt > LIMITS.planMs) plans.delete(id)
    if (plans.size >= LIMITS.plans) throw fault('COMFY_ROUTER_PLAN_LIMIT', 'Too many recent previews. Wait for an older preview to expire (previews last 10 minutes), then create another. Existing jobs remain recorded.')
    const each = await quote(op, built.model, built.choices, await policy(op))
    needCredential()
    const estimate = each && count > 1 ? { ...priced(built.model, each.usd * count, each.firm, each.basis, each.asOf), each: each.usd, count,
      ...(each.range ? { range: { low: each.range.low * count, high: each.range.high * count } } : {}),
      label: `${each.firm ? 'About' : 'Usually about'} $${(each.usd * count).toFixed(2)} for ${count} pictures ($${each.usd.toFixed(2)} each, charged separately). ${each.basis === 'live' ? 'Quoted by Comfy' : 'Recorded'} ${each.asOf}; final provider billing may differ.` } : each
    const planId = randomUUID()
    const plan = { context: { ...op.context }, credentialId, prompt: built.choices.prompt, createdAt: now(), jobId: null,
      create: { model: built.model, choices: built.choices, body: built.body, estimate, count } }
    plans.set(planId, plan)
    return planView(planId, plan, await policy(op))
  }) }
  // Every picture sent to a Gemini picture model carries its own fresh seed,
  // set at the moment it is sent. Google picks a random one when none is
  // given, so this changes nothing about how varied the results are; it makes
  // sure of it at this end, and keeps several pictures from one plan (which
  // share one prepared request) from ever sharing a seed.
  function withFreshSeed(spec, body) {
    if (spec?.model?.format !== 'gemini-image' || !object(body) || !object(body.generationConfig)) return body
    return { ...body, generationConfig: { ...body.generationConfig, seed: newSeed() } }
  }
  // A batch: many DIFFERENT picture requests under one price and one approval,
  // for the Director's keyframes. Each request is still its own record with
  // its own idempotency key, sent one after another; the first failure stops
  // the rest. Reference pictures are sent once in `pictures` and named by id,
  // so a person used in fifty shots is held once.
  const BATCH_MAX = 200, BATCH_PICTURES_MAX = 24
  function batchBody(spec, index) {
    const item = spec.items[index]
    return buildCreateRequest(spec.model.id, { prompt: item.prompt, shape: item.shape, size: item.size,
      ...(item.pictureIds.length ? { pictures: item.pictureIds.map(id => spec.pictures[id]) } : {}) }).body
  }
  function previewCreateBatch(payload) { return perform(payload, ['modelId', 'items', 'pictures'], async op => {
    needCredential()
    if (!Array.isArray(payload.items) || payload.items.length < 1 || payload.items.length > BATCH_MAX) throw fault('COMFY_ROUTER_INVALID', `A batch holds 1 to ${BATCH_MAX} pictures.`)
    if (!object(payload.pictures) || Object.keys(payload.pictures).length > BATCH_PICTURES_MAX) throw invalid()
    const pictures = {}
    for (const [id, picture] of Object.entries(payload.pictures)) {
      if (!identifier(id)) throw invalid()
      // Checked through the same door as a single request's picture.
      const built = buildOrRefuse(payload.modelId, { prompt: 'check', pictures: [picture] })
      checkPictureHeader(built.pictures[0])
      pictures[id] = built.pictures[0]
    }
    let model = null
    const items = payload.items.map(item => {
      if (!exact(item, ['prompt', 'shape', 'size', 'pictureIds']) || !Array.isArray(item.pictureIds) || item.pictureIds.some(id => !Object.hasOwn(pictures, id))) throw invalid()
      const built = buildOrRefuse(payload.modelId, { prompt: item.prompt, shape: item.shape, size: item.size,
        ...(item.pictureIds.length ? { pictures: item.pictureIds.map(id => pictures[id]) } : {}) })
      if (built.model.kind !== 'image') throw fault('COMFY_ROUTER_INVALID', 'Only pictures can be made as a batch.')
      if (secretLike(built.choices.prompt, credential)) throw invalid()
      if (!allowPending && built.model.pending) throw fault('COMFY_ROUTER_INVALID', 'That model is not available yet.')
      model = built.model
      return { prompt: built.choices.prompt, shape: built.choices.shape, size: built.choices.size, pictureIds: [...item.pictureIds] }
    })
    for (const [id, plan] of plans) if (now() - plan.createdAt > LIMITS.planMs) plans.delete(id)
    if (plans.size >= LIMITS.plans) throw fault('COMFY_ROUTER_PLAN_LIMIT', 'Too many recent previews. Wait for an older preview to expire (previews last 10 minutes), then create another. Existing jobs remain recorded.')
    // Priced from Velorn's recorded price for each picture: asking Comfy would
    // mean one question per picture, and a request with pictures is never quoted live.
    const count = items.length
    let total = 0, known = true, asOf = null, basis = null
    for (const item of items) {
      const each = createEstimate(model.id, { prompt: item.prompt, shape: item.shape, size: item.size, ...(item.pictureIds.length ? { hasPicture: true } : {}) })
      if (!each) { known = false; break }
      total += each.usd; asOf = each.asOf; basis = each.basis
    }
    const estimate = known ? { ...priced(model, total, false, basis, asOf), each: total / count, count,
      label: `Usually about $${total.toFixed(2)} for ${count} ${count === 1 ? 'picture' : 'pictures'} (about $${(total / count).toFixed(2)} each, charged separately). Recorded ${asOf}; final provider billing may differ.` } : null
    const planId = randomUUID()
    const first = items[0]
    const plan = { context: { ...op.context }, credentialId, prompt: first.prompt, createdAt: now(), jobId: null,
      create: { model, choices: { prompt: first.prompt, shape: first.shape, size: first.size, ...(first.pictureIds.length ? { hasPicture: true } : {}) }, body: null, items, pictures, estimate, count } }
    plans.set(planId, plan)
    return planView(planId, plan, await policy(op))
  }) }
  function buildOrRefuse(modelId, choices) {
    try { return buildCreateRequest(modelId, choices) }
    catch (error) { throw error?.code === 'CREATE_REQUEST_INVALID' ? fault('COMFY_ROUTER_INVALID', error.message) : error }
  }
  // Sends one wait-for-the-result request and keeps what comes back. It runs
  // apart from the call that started it, so the screen can keep watching the
  // record. It is sent ONCE: any outcome that is not a clear yes or a clear no
  // is recorded as unclear and never tried again.
  function runSync(job, body) {
    const controller = new AbortController(), key = credential
    background.add(controller)
    const timer = setTimeout(() => controller.abort(), syncTimeoutMs)
    const settle = (status, errorType, diagnostics) => { job.status = status; if (errorType) job.errorType = errorType; if (validDiagnostics(diagnostics)) job.diagnostics = { ...diagnostics } }
    ;(async () => {
      try {
        const response = await fetchImpl(endpoint('', job.model), { method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', signal: controller.signal,
          headers: { 'X-API-Key': key, 'Content-Type': 'application/json', 'Idempotency-Key': job.id }, body: JSON.stringify(body) })
        if (!response?.ok) {
          const status = response?.status, definite = status >= 400 && status < 500 && ![408, 409].includes(status)
          try { await response?.body?.cancel?.() } catch {}
          settle(definite ? 'FAILED' : 'UNCERTAIN', definite ? 'REQUEST_REJECTED' : 'SUBMISSION_UNCERTAIN', responseDiagnostics(response, key))
          return
        }
        const used = response.headers?.get?.('x-comfy-credits-used')
        if (/^\d{1,7}(?:\.\d{1,6})?$/.test(used || '')) job.create.credits = Number(used)
        // From here Comfy has run the request, so a problem is a failed result, not an unclear one.
        let data = null
        try {
          const reader = response.body.getReader(), chunks = []; let length = 0
          while (length <= AUDIO_MAX) { const item = await reader.read(); if (item.done) break; length += item.value.byteLength; chunks.push(Buffer.from(item.value)) }
          try { await reader.cancel() } catch {}
          if (length <= AUDIO_MAX) data = Buffer.concat(chunks)
        } catch { data = null }
        // Some models answer with the address of the finished sound instead of the sound itself.
        // It is collected at once, without the key, from the address given.
        const format = getModel(job.create.modelId)?.format
        if (data && !audioHeader(data) && LINKED_AUDIO.has(format)) {
          let offered = null
          try { const parsed = data.length <= LIMITS.response ? JSON.parse(data.toString('utf8')) : null; offered = object(parsed) ? resultLink(format, parsed) : null } catch { offered = null }
          const link = storageLink(offered)
          if (allowPending && typeof offered === 'string') { try { const at = new URL(offered); console.warn(`[comfy-router] ${format} result is at ${at.protocol}//${at.host}${at.pathname.split('/').slice(0, 2).join('/')}/… ${link ? '(accepted)' : '(not a usable address)'}`) } catch {} }
          data = null
          if (link) {
            try {
              const file = await fetchImpl(link, { method: 'GET', redirect: 'follow', credentials: 'omit', cache: 'no-store', signal: controller.signal, headers: {} })
              if (file?.ok) {
                const reader = file.body.getReader(), chunks = []; let length = 0
                while (length <= AUDIO_MAX) { const item = await reader.read(); if (item.done) break; length += item.value.byteLength; chunks.push(Buffer.from(item.value)) }
                try { await reader.cancel() } catch {}
                if (length <= AUDIO_MAX) data = Buffer.concat(chunks)
              } else { try { await file?.body?.cancel?.() } catch {} }
            } catch { data = null }
          }
        }
        if (!data || !(audioHeader(data) || otherSound(data))) { settle('FAILED', 'RESULT_UNREADABLE'); return }
        try { await fs.writeFile(resultFile(job), data, { mode: 0o600, flag: 'wx' }) } catch { settle('FAILED', 'RESULT_UNSAVED'); return }
        settle('COMPLETED')
      } catch { settle('UNCERTAIN', 'SUBMISSION_UNCERTAIN') }
      finally {
        clearTimeout(timer); background.delete(controller)
        job.updatedAt = now(); await persist().catch(() => {}); announce(job)
      }
    })()
  }
  // `submit` always asks through the native confirmation. `submitCreate` is for
  // a person's own click in the Create tab and may let the priced button stand
  // as the approval; it must never be exposed to agent tools.
  function submit(payload) { return submitWith(payload, false) }
  function submitCreate(payload) { return submitWith(payload, true) }
  // The same priced button, tapped on the person's paired phone. The tap stands
  // as the approval up to the same limit. Above it the phone must send back the
  // exact price the person confirmed in a second step (`confirmedUsd`), up to
  // PHONE_CONFIRM_MAX_USD. Beyond that, or with no set price, nothing is sent:
  // the native confirmation would open on a computer nobody may be sitting at.
  // Reached only through the phone connection's Create bridge, never by IPC or agents.
  function submitCreateRemote(payload) {
    if (!exact(payload, ['planId']) && !exact(payload, ['planId', 'confirmedUsd'])) return Promise.resolve(fail(invalid()))
    return submitWith({ planId: payload.planId }, true, { confirmedUsd: payload.confirmedUsd })
  }
  function submitWith(payload, personClicked, remote = null) { return perform(payload, ['planId'], async op => {
    const plan = checkedPlan(op, payload.planId)
    const spec = plan.create || null
    if (personClicked && !spec) throw invalid()
    const buttonApproved = personClicked && Boolean(spec.estimate) && spec.estimate.usd <= BUTTON_APPROVAL_USD
    // The most this request is expected to cost: the top of a quoted range when there is one.
    const ceiling = spec?.estimate ? Math.max(spec.estimate.usd, spec.estimate.range?.high ?? 0) : null
    const phoneConfirmable = Boolean(remote) && !buttonApproved && ceiling !== null && ceiling <= PHONE_CONFIRM_MAX_USD
    const phoneConfirmed = phoneConfirmable && typeof remote.confirmedUsd === 'number' && remote.confirmedUsd === spec.estimate.usd
    const count = spec ? spec.count : 1
    if (plan.jobId) return { success: true, repeated: true, job: view(owned(op, plan.jobId)), ...(spec ? { jobs: (plan.jobIds || [plan.jobId]).map(id => view(owned(op, id))) } : {}) }
    if (busySubmit) throw fault('COMFY_ROUTER_BUSY', 'Another image submission is awaiting approval or a provider response.')
    if (jobs.size + count > LIMITS.jobs) throw fault('COMFY_ROUTER_LEDGER_FULL', 'The Router job record is full. No job was submitted.')
    if ([...jobs.values()].some(job => job.projectKey === op.context.projectKey && job.credentialFingerprint === credentialId && job.status === 'UNCERTAIN' && !job.providerJobId
      && !(syncModel(job) && now() - job.updatedAt > SYNC_SETTLED_MS))) {
      throw fault('COMFY_ROUTER_UNCERTAIN', 'An earlier submission has no confirmed provider identifier. Inspect your Comfy account before starting another image; Velorn will not retry or risk a duplicate charge.')
    }
    busySubmit = true
    let job, dispatched = false
    const sentJobs = []
    try {
      if (await policy(op) !== 'ask-cloud') throw fault('COMFY_ROUTER_LOCAL_ONLY', 'Local only blocks this paid cloud image. Enable Ask before cloud in Generation spending settings first.')
      if (remote && !buttonApproved && !phoneConfirmed) {
        if (phoneConfirmable) throw fault('COMFY_ROUTER_CONFIRM_REQUIRED', 'Confirm the price on the phone before this request is sent. No job was submitted.')
        throw fault('COMFY_ROUTER_APPROVAL_UNAVAILABLE', ceiling === null ? 'This request has no set price, so it has to be started in Velorn on the computer. No job was submitted.'
          : `This request is priced above the $${PHONE_CONFIRM_MAX_USD} that can be approved from the phone. Start it in Velorn on the computer. No job was submitted.`)
      }
      if (!buttonApproved && !phoneConfirmed) {
        if (typeof confirmSpend !== 'function') throw fault('COMFY_ROUTER_APPROVAL_UNAVAILABLE', 'Native spending confirmation is unavailable. No job was submitted.')
        const approved = await abortable(op, () => confirmSpend(spec
          ? { planId: payload.planId, create: true, model: spec.model.model, modelLabel: spec.model.name, kind: spec.model.kind, choices: { ...spec.choices },
            prompt: plan.prompt, estimate: spec.estimate, refusalCharged: spec.model.refusalCharged, projectKey: op.context.projectKey, submissionCount: count,
            // True for a click in the Create tab, false for an agent or MCP client.
            fromPerson: personClicked, signal: op.controller.signal }
          : { planId: payload.planId, model: MODEL, modelLabel: MODEL_LABEL,
            width: WIDTH, height: HEIGHT, prompt: plan.prompt, estimate: ESTIMATE, projectKey: op.context.projectKey, submissionCount: 1, fromPerson: personClicked, signal: op.controller.signal }))
        await check(op)
        if (!(approved === true || approved?.confirmed === true)) throw fault('COMFY_ROUTER_DECLINED', 'Image generation was not approved. No job was submitted.')
      }
      if (await policy(op) !== 'ask-cloud') throw fault('COMFY_ROUTER_LOCAL_ONLY', 'The spending policy changed. No job was submitted.')
      if (plans.get(payload.planId) !== plan || credentialId !== plan.credentialId) throw fault('COMFY_ROUTER_PLAN_INVALID', 'The preview or key changed. No job was submitted.')
      // One request per picture, one after another. Each gets its own record and
      // its own idempotency key BEFORE it is sent; the first failure stops the rest.
      for (let index = 0; index < count; index++) {
      job = null; dispatched = false
      // A batch builds each request only now, so its pictures are held once, not once per request.
      const body = withFreshSeed(spec, spec?.items ? batchBody(spec, index) : spec?.body)
      job = { id: randomUUID(), projectKey: op.context.projectKey, credentialFingerprint: credentialId, model: spec ? spec.model.model : MODEL,
        status: 'SUBMITTING', createdAt: now(), updatedAt: now(),
        ...(spec ? { create: { modelId: spec.model.id, usd: spec.estimate ? (spec.estimate.each ?? spec.estimate.usd) : null,
          ...(expectedPixels(spec.model.format, body) ? { pixels: expectedPixels(spec.model.format, body) } : {}) } } : {}) }
      jobs.set(job.id, job); if (!plan.jobId) plan.jobId = job.id
      if (remote) { phoneJobs.add(job.id); await savePhoneJobs() }
      plan.jobIds = [...(plan.jobIds || []), job.id]
      await persist(); await check(op)
      if (await policy(op) !== 'ask-cloud') throw fault('COMFY_ROUTER_LOCAL_ONLY', 'The spending policy changed. No job was submitted.')
      dispatched = true
      if (syncModel(job)) { runSync(job, body); announce(job); sentJobs.push(job); continue }
      const result = await request(op, endpoint('/requests', job.model), { method: 'POST', idempotency: job.id, body: spec ? body : {
        prompt: plan.prompt, size: '1024x1024', response_format: 'b64_json', sequential_image_generation: 'disabled', stream: false, watermark: true } })
      const providerId = result.request_id
      if (!identifier(providerId)) throw fault('COMFY_ROUTER_RESPONSE', 'The provider did not return a verifiable job identifier. Do not submit again; inspect your Comfy account.')
      job.providerJobId = providerId; job.status = 'IN_QUEUE'; job.updatedAt = now()
      refreshAfter.set(job.id, now() + op.retryAfterMs)
      await persist(); await check(op); announce(job)
      sentJobs.push(job)
      }
      return { success: true, job: view(sentJobs[0]), ...(spec ? { jobs: sentJobs.map(view), approval: buttonApproved ? 'button' : phoneConfirmed ? 'phone' : 'dialog' } : {}) }
    } catch (error) {
      if (job && !sentJobs.includes(job)) {
        const rejected = faults.has(error) && error.definiteRejection === true
        job.status = dispatched ? rejected ? 'FAILED' : 'UNCERTAIN' : 'CANCELLED'; job.updatedAt = now(); job.errorType = dispatched ? rejected ? 'REQUEST_REJECTED' : 'SUBMISSION_UNCERTAIN' : 'NOT_SUBMITTED'
        if (faults.has(error) && validDiagnostics(error.diagnostics)) job.diagnostics = { ...error.diagnostics }
        await persist().catch(() => {}); announce(job)
        // Some pictures of a set were already accepted: report those, and why the rest were not sent.
        if (sentJobs.length) return { success: true, partial: true, job: view(sentJobs[0]), jobs: sentJobs.map(view), approval: buttonApproved ? 'button' : 'dialog',
          stopped: { ...(dispatched && !rejected ? { code: 'COMFY_ROUTER_UNCERTAIN', error: 'One request has an unclear outcome. It may still run and spend credits.' } : fail(error)), job: view(job) } }
        if (dispatched) return rejected ? { ...fail(error), job: view(job) } : { success: false, code: 'COMFY_ROUTER_UNCERTAIN', error: 'The submission outcome is uncertain. It may still run and spend credits. Do not resubmit; inspect the recorded job or your Comfy account.',
          ...(validDiagnostics(job.diagnostics) ? { diagnostics: { ...job.diagnostics } } : {}), job: view(job) }
      }
      throw error
    } finally { busySubmit = false }
  }) }
  function list(payload = {}) { return perform(payload, [], async op => ({ success: true, jobs: [...jobs.values()].filter(job => job.projectKey === op.context.projectKey).map(view).sort((a, b) => b.createdAt - a.createdAt) }), false) }
  async function refreshJob(op, job) {
    if (rejectedSubmission(job) || stoppedBeforeSubmission(job)) {
      return { success: true, cached: true, job: view(job), summary: rejectedSubmission(job) ? submissionErrorMessage(job) : NOT_SUBMITTED_MESSAGE }
    }
    // The record is the whole truth for a wait-for-the-result request; there is nothing to ask Comfy.
    if (syncModel(job)) return { success: true, cached: true, job: view(job) }
    needCredential(job)
    if (!job.providerJobId) throw fault('COMFY_ROUTER_UNCERTAIN', 'This job has no confirmed provider identifier. Inspect your Comfy account before submitting anything again.')
    if ((refreshAfter.get(job.id) || 0) > now()) return { success: true, job: view(job), waiting: true }
    const result = await request(op, endpoint(`/requests/${encodeURIComponent(job.providerJobId)}/status`, job.model))
    if (!['IN_QUEUE', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED'].includes(result.status)) throw fault('COMFY_ROUTER_RESPONSE', 'The provider returned an unrecognized job state. No new work was submitted.')
    job.status = result.error_type || result.error ? 'FAILED' : result.status; job.updatedAt = now()
    if (job.create && op.creditsUsed !== undefined) job.create.credits = op.creditsUsed
    refreshAfter.set(job.id, now() + op.retryAfterMs)
    if (job.status === 'FAILED') job.errorType = safeErrorType(result.error_type)
    else delete job.errorType
    await persist(); await check(op); announce(job)
    return { success: true, job: view(job) }
  }
  function refresh(payload) { return perform(payload, ['jobId'], op => refreshJob(op, owned(op, payload.jobId))) }
  function cancel(payload) { return perform(payload, ['jobId'], async op => {
    const job = owned(op, payload.jobId); needCredential(job)
    if (TERMINAL.has(job.status)) return { success: true, job: view(job), summary: 'The job is already finished. No cancellation request was sent.' }
    if (!job.providerJobId) throw fault('COMFY_ROUTER_UNCERTAIN', 'Cancellation cannot be confirmed without a provider identifier. Inspect your Comfy account; the job may still run.')
    if (job.cancelState === 'UNCERTAIN' || job.cancelState === 'PENDING') {
      return { success: false, code: 'COMFY_ROUTER_CANCEL_UNCERTAIN', error: 'Cancellation has not been confirmed. Refresh the job or inspect your Comfy account; the job may still run and spend credits.', job: view(job) }
    }
    if (job.cancelState !== 'REQUESTED') {
      job.cancelState = 'PENDING'; job.updatedAt = now(); await persist(); await check(op)
      try {
        await request(op, endpoint(`/requests/${encodeURIComponent(job.providerJobId)}/cancel`, job.model), { method: 'PUT' })
        job.cancelState = 'REQUESTED'; job.updatedAt = now(); await persist(); await check(op)
      } catch (error) {
        job.cancelState = 'UNCERTAIN'; job.updatedAt = now(); await persist().catch(() => {}); announce(job)
        return { success: false, code: 'COMFY_ROUTER_CANCEL_UNCERTAIN', error: 'The cancellation request could not be confirmed. Refresh the job or inspect your Comfy account; no retry was made.', job: view(job) }
      }
    }
    announce(job)
    return { success: true, job: view(job), summary: 'Cancellation was requested. It is not a refund or proof the job stopped. Refresh to check the provider state.' }
  }) }
  function output(payload) { return perform(payload, ['jobId'], async op => {
    const job = owned(op, payload.jobId); if (!syncModel(job)) needCredential(job)
    if (job.status !== 'COMPLETED') throw fault('COMFY_ROUTER_NOT_COMPLETE', 'Wait for the provider to report the image completed before importing it.')
    if (job.create) return createOutput(op, job)
    const result = await request(op, endpoint(`/requests/${encodeURIComponent(job.providerJobId)}`), { resultBody: true }); await check(op)
    if (op.responseStatus === 202) throw fault('COMFY_ROUTER_NOT_COMPLETE', 'The provider result is not ready yet. Refresh the existing job; no new image was submitted.')
    if (result.error_type || result.error) throw fault('COMFY_ROUTER_OUTPUT_UNVERIFIED', 'The provider reported a generation failure. No media was imported.')
    const encoded = Array.isArray(result.data) && result.data.length === 1 ? result.data[0]?.b64_json : null
    if (typeof encoded !== 'string' || !encoded.length || encoded.length > 4 * Math.ceil(LIMITS.image / 3)
      || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw fault('COMFY_ROUTER_OUTPUT_UNVERIFIED', 'The provider did not return one bounded inline image. No URL fallback or media import was attempted.')
    const data = Buffer.from(encoded, 'base64')
    if (!data.length || data.length > LIMITS.image || data.toString('base64') !== encoded) throw fault('COMFY_ROUTER_OUTPUT_UNVERIFIED', 'The provider returned invalid image data. No media was imported.')
    return pictureOutput(op, job, data)
  }) }
  // Fetches one result file from the address Comfy gave. The Comfy key is NOT
  // sent: the link is already signed. Redirects are followed, each one checked
  // like the first address; the link is never stored or returned.
  async function download(op, link, maximum) {
    if (typeof fetchImpl !== 'function') throw fault('COMFY_ROUTER_UNAVAILABLE', 'Comfy Router transport is unavailable. Restart Velorn.')
    await check(op)
    const timer = setTimeout(() => op.controller.abort('timeout'), timeoutMs * 4)
    try {
      let response, at = link
      for (let hop = 0; ; hop++) {
        try { response = await abortable(op, () => fetchImpl(at, { method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store', signal: op.controller.signal, headers: {} })) }
        catch (error) { if (faults.has(error)) throw error; throw fault('COMFY_ROUTER_OUTPUT_UNVERIFIED', 'The finished result could not be downloaded. Nothing was imported and no new request was submitted.') }
        const next = response && response.status >= 300 && response.status < 400 ? response.headers?.get?.('location') : null
        if (!next) break
        try { await response.body?.cancel?.() } catch {}
        let target = null
        try { target = storageLink(new URL(next, at).href) } catch { target = null }
        if (!target || hop >= 5) throw fault('COMFY_ROUTER_OUTPUT_UNVERIFIED', 'The finished result could not be downloaded. Nothing was imported and no new request was submitted.')
        at = target
      }
      await check(op)
      if (!response?.ok) {
        try { await response?.body?.cancel?.() } catch {}
        throw fault('COMFY_ROUTER_OUTPUT_UNVERIFIED', 'The finished result could not be downloaded. The link may have expired. Nothing was imported and no new request was submitted.')
      }
      const data = await bytes(response, op, maximum); await check(op)
      return data
    } finally { clearTimeout(timer) }
  }
  // One result from a Create model: an inline picture, or a file behind a link
  // to Comfy's result storage. The same checks as the original path, with the
  // size taken from what was asked for instead of a fixed 1024.
  const audioOutput = (job, data) => {
    const header = audioHeader(data) || otherSound(data)
    if (!header) throw fault('COMFY_ROUTER_OUTPUT_UNVERIFIED', 'Comfy returned a message instead of a sound file. Nothing was imported.')
    return { success: true, jobId: job.id, kind: 'audio', made: getModel(job.create.modelId).kind, bytes: new Uint8Array(data), mimeType: header.mimeType, filename: `velorn-router-${job.id}.${header.extension}` }
  }
  async function createOutput(op, job) {
    const model = getModel(job.create.modelId)
    if (syncModel(job)) {
      let data
      try {
        const handle = await fs.open(resultFile(job), fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW || 0))
        try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > AUDIO_MAX) throw new Error('bad result'); data = await handle.readFile() } finally { await handle.close() }
      } catch { throw fault('COMFY_ROUTER_OUTPUT_UNVERIFIED', 'The finished audio is no longer on this computer. Nothing was imported and no new request was sent.') }
      await check(op)
      return audioOutput(job, data)
    }
    const result = await request(op, endpoint(`/requests/${encodeURIComponent(job.providerJobId)}`, job.model), { resultBody: true }); await check(op)
    if (op.responseStatus === 202) throw fault('COMFY_ROUTER_NOT_COMPLETE', 'The provider result is not ready yet. Refresh the existing job; no new request was submitted.')
    if (op.creditsUsed !== undefined && job.create.credits !== op.creditsUsed) { job.create.credits = op.creditsUsed; job.updatedAt = now(); await persist(); await check(op) }
    if (result.error_type || result.error) throw fault('COMFY_ROUTER_OUTPUT_UNVERIFIED', 'The provider reported a generation failure. No media was imported.')
    let data
    if (INLINE_FORMATS.has(model.format)) {
      const encoded = inlinePicture(model.format, result)
      if (typeof encoded !== 'string' || !encoded.length || encoded.length > 4 * Math.ceil(LIMITS.image / 3)
        || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw fault('COMFY_ROUTER_OUTPUT_UNVERIFIED', 'The provider did not return one bounded inline picture. It may have declined the request or returned a picture too large to save. No link was followed and nothing was imported.')
      data = Buffer.from(encoded, 'base64')
      if (!data.length || data.length > LIMITS.image || data.toString('base64') !== encoded) throw fault('COMFY_ROUTER_OUTPUT_UNVERIFIED', 'The provider returned invalid picture data. No media was imported.')
    } else {
      const offered = resultLink(model.format, result)
      if (typeof offered !== 'string') throw fault('COMFY_ROUTER_OUTPUT_UNVERIFIED', 'The provider did not return a finished result. It may have declined the request. Nothing was imported.')
      const link = storageLink(offered)
      if (!link) throw fault('COMFY_ROUTER_OUTPUT_UNVERIFIED', 'Comfy did not give a usable download address for the finished result. Nothing was downloaded. It stays on Comfy for 24 hours.')
      data = await download(op, link, model.kind === 'video' ? VIDEO_MAX : isAudio(model) ? AUDIO_MAX : LIMITS.image)
      if (!data.length) throw fault('COMFY_ROUTER_OUTPUT_UNVERIFIED', 'The downloaded result was empty. Nothing was imported.')
    }
    if (isAudio(model)) return audioOutput(job, data)
    if (model.kind === 'video') {
      const container = videoHeader(data) || otherVideo(data)
      if (!container) throw fault('COMFY_ROUTER_OUTPUT_UNVERIFIED', 'Comfy returned a message instead of a video file. Nothing was imported.')
      return { success: true, jobId: job.id, kind: 'video', bytes: new Uint8Array(data), mimeType: container.mimeType, filename: `velorn-router-${job.id}.${container.extension}` }
    }
    return pictureOutput(op, job, data)
  }
  // A picture is kept whatever its size: a model that answers with other dimensions than were asked for
  // has still made (and charged for) a picture. The size comes from the file's own header.
  async function pictureOutput(op, job, data) {
    let declared = null
    const header = imageHeader(data, (width, height) => {
      const ok = Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0
      if (ok) declared = { width, height }
      return ok
    })
    if (!header || !declared) throw fault('COMFY_ROUTER_OUTPUT_UNVERIFIED', 'Comfy returned something that is not a picture Velorn can read. Nothing was imported.')
    const { mimeType, extension } = header
    const size = declared
    return { success: true, jobId: job.id, bytes: new Uint8Array(data), mimeType, width: size.width, height: size.height, filename: `velorn-router-${job.id}.${extension}` }
  }
  function markImported(payload) { return perform(payload, ['jobId', 'assetId'], async op => {
    const job = owned(op, payload.jobId)
    if (job.status !== 'COMPLETED' || !identifier(payload.assetId)) throw invalid()
    job.importedAssetId = payload.assetId; job.updatedAt = now(); await persist()
    // The project has its own copy now.
    if (syncModel(job)) await fs.unlink(resultFile(job)).catch(() => {})
    await check(op); announce(job)
    return { success: true, job: view(job) }
  }) }
  return { status, models, balance, connect, clear, preview, previewCreate, previewCreateBatch, inspectPlan, submit, submitCreate, submitCreateRemote, list, refresh, cancel, output, markImported,
    cancelPending: stop, dispose: () => { stop(); disposed = true; plans.clear(); credential = ''; credentialId = ''; for (const controller of background) controller.abort() } }
}

module.exports = { createComfyRouter, MODEL, MODEL_LABEL, WIDTH, HEIGHT, ESTIMATE, ORIGIN, LIMITS, BUTTON_APPROVAL_USD, PHONE_CONFIRM_MAX_USD, RESULT_STORAGE, VIDEO_MAX, AUDIO_MAX, audioHeader }
