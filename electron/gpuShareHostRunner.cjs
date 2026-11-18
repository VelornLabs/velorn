'use strict'
// Runs ONE approved network job on this computer's own ComfyUI and hands back
// the finished clip or picture. This is the host's side of "Run on Velorn network".
//
// It talks only to the loopback ComfyUI. It takes a workflow id from
// gpuShareWorkflows.cjs and a few plain choices, never a workflow or a path.
// Before anything is queued it checks that this ComfyUI has every node and
// model the workflow needs and that the bound graph is entirely local (the same
// audited list the rest of Velorn uses), so a network job can never reach a
// paid or unknown node. It does not decide WHETHER to run a job: who may ask,
// content checks and limits belong to its caller.
const { createHash, randomInt } = require('node:crypto')
const { classifyGenerationGraph } = require('./generationSpendingPolicy.cjs')
const { getApproved, checkImage, refuse, PLACEHOLDER_IMAGE } = require('./gpuShareWorkflows.cjs')

const LIMITS = Object.freeze({ objectInfoBytes: 96 * 1024 * 1024, jsonBytes: 8 * 1024 * 1024, resultBytes: 256 * 1024 * 1024,
  requestMs: 30000, uploadMs: 60000, downloadMs: 120000 })
const MODEL_FILE = /\.(?:safetensors|ckpt|pth|pt|gguf|bin)$/i
const VIDEO = Object.freeze({ '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' })
const IMAGE = Object.freeze({ '.png': 'image/png' })
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const safeJobId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(value)

function loopback(endpoint) {
  let url
  try { url = new URL(endpoint) } catch { throw refuse('ComfyUI is not set up on this computer.', 'GPU_SHARE_COMFY_UNAVAILABLE') }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw refuse('Network jobs only run on this computer\'s own ComfyUI.', 'GPU_SHARE_COMFY_UNAVAILABLE')
  }
  return url.origin
}

// The choices a loader offers: ComfyUI lists them either as the first item of
// the input's description or under options.
function offered(objectInfo, classType, key) {
  const spec = objectInfo?.[classType]?.input?.required?.[key] ?? objectInfo?.[classType]?.input?.optional?.[key]
  if (!Array.isArray(spec)) return null
  if (Array.isArray(spec[0])) return spec[0]
  return Array.isArray(spec[1]?.options) ? spec[1].options : null
}
function missingModels(workflow, objectInfo) {
  const missing = new Set()
  for (const node of Object.values(workflow)) {
    for (const [key, value] of Object.entries(node?.inputs || {})) {
      if (typeof value !== 'string' || !MODEL_FILE.test(value)) continue
      const list = offered(objectInfo, node.class_type, key)
      if (!list || !list.includes(value)) missing.add(value)
    }
  }
  return [...missing].sort()
}

function createGpuShareHostRunner({ getEndpoint, readWorkflow, fetchImpl = globalThis.fetch, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), pollMs = 2000, maxRunMs = 20 * 60 * 1000,
  randomSeed = () => randomInt(1, 2 ** 40), resolveOwn = null } = {}) {
  if (typeof getEndpoint !== 'function' || typeof readWorkflow !== 'function' || typeof fetchImpl !== 'function') throw new TypeError('The network job runner needs a ComfyUI endpoint, the bundled workflows and a transport.')

  async function call(base, route, { method = 'GET', body, headers, timeoutMs = LIMITS.requestMs, maxBytes = LIMITS.jsonBytes, binary = false } = {}) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(`${base}${route}`, { method, body, headers, redirect: 'error', signal: controller.signal })
      const declared = Number(response.headers?.get?.('content-length'))
      if (Number.isFinite(declared) && declared > maxBytes) throw refuse('ComfyUI sent more than expected.', 'GPU_SHARE_COMFY_FAILED')
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.length > maxBytes) throw refuse('ComfyUI sent more than expected.', 'GPU_SHARE_COMFY_FAILED')
      if (binary) return { ok: response.ok, status: response.status, bytes }
      let value = null
      try { value = bytes.length ? JSON.parse(bytes.toString('utf8')) : null } catch { value = null }
      return { ok: response.ok, status: response.status, value }
    } catch (error) {
      if (error?.publicMessage) throw error
      throw refuse('ComfyUI on this computer did not answer.', 'GPU_SHARE_COMFY_UNAVAILABLE')
    } finally { clearTimeout(timer) }
  }

  // Velorn's own short list first. Anything else must be one of this computer's
  // owner's own added workflows (gpuShareOwnWorkflows.cjs), which brings its graph with it.
  async function prepared(workflowId, own = null) {
    const found = own || (getApproved(workflowId) ? null : typeof resolveOwn === 'function' ? await resolveOwn(workflowId) : null)
    const entry = found ? found.entry : getApproved(workflowId)
    if (!entry) throw refuse('That workflow is not offered on the Velorn network.', 'GPU_SHARE_WORKFLOW_UNKNOWN')
    const base = loopback(await getEndpoint())
    let template
    if (found) template = found.template
    else try { template = await readWorkflow(entry.file) } catch { template = null }
    if (!plain(template)) throw refuse('This Velorn is missing the workflow file. Reinstall or update Velorn.', 'GPU_SHARE_WORKFLOW_CHANGED')
    const info = await call(base, '/object_info', { maxBytes: LIMITS.objectInfoBytes })
    if (!info.ok || !plain(info.value)) throw refuse('ComfyUI on this computer did not answer.', 'GPU_SHARE_COMFY_UNAVAILABLE')
    return { entry, base, template, objectInfo: info.value }
  }
  function judge(workflow, objectInfo) {
    const verdict = classifyGenerationGraph(workflow, objectInfo)
    if (verdict.risk !== 'local') return { ok: false, code: 'GPU_SHARE_NOT_LOCAL',
      reason: verdict.unknownNodes?.length ? 'This ComfyUI is missing parts the workflow needs, or has a different version of them. Update ComfyUI.' : 'This workflow would use a paid or unknown part here, so it is not run for the network.',
      unknownNodes: [...new Set((verdict.unknownNodes || []).map(node => node.classType))].slice(0, 20) }
    const missing = missingModels(workflow, objectInfo)
    if (missing.length) return { ok: false, code: 'GPU_SHARE_MODELS_MISSING', reason: 'This computer does not have all the model files this workflow needs.', missingModels: missing }
    return { ok: true }
  }

  // Can this computer run that workflow right now? Used to decide what to offer.
  async function capability(workflowId) {
    try {
      const { entry, template, objectInfo } = await prepared(workflowId)
      // Bound with stand-in choices: the same nodes and model files as a real job.
      const { workflow } = entry.bind(template, entry.normalize({ prompt: 'capability check' }), { imageName: 'capability.png', prefix: 'velorn_network/check', randomSeed: () => 1 })
      return { workflowId: entry.id, ...judge(workflow, objectInfo) }
    } catch (error) { return { workflowId, ok: false, code: error?.code || 'GPU_SHARE_FAILED', reason: error?.publicMessage || 'This workflow cannot be checked right now.' } }
  }

  async function uploadImage(base, image) {
    const extension = checkImage(image)
    const name = `velorn_network_${createHash('sha256').update(image.bytes).digest('hex')}.${extension}`
    const form = new FormData()
    form.append('image', new Blob([image.bytes], { type: image.mimeType }), name)
    form.append('type', 'input')
    form.append('overwrite', 'true') // Only our own content-addressed name.
    const receipt = await call(base, '/upload/image', { method: 'POST', body: form, timeoutMs: LIMITS.uploadMs, maxBytes: 16 * 1024 })
    if (!receipt.ok || receipt.value?.name !== name || (receipt.value.subfolder || '') !== '' || receipt.value.type !== 'input') throw refuse('ComfyUI did not take the input picture.', 'GPU_SHARE_COMFY_FAILED')
    return name
  }

  // Where is our prompt: waiting, running, or neither?
  async function position(base, promptId) {
    const queue = await call(base, '/queue')
    const has = list => Array.isArray(list) && list.some(item => Array.isArray(item) && item[1] === promptId)
    return !queue.ok || !plain(queue.value) ? 'unknown' : has(queue.value.queue_running) ? 'running' : has(queue.value.queue_pending) ? 'queued' : 'none'
  }
  // Stopping never touches anyone else's work: a waiting job is removed by its
  // own id, and an interrupt is sent only while OUR job is the one running.
  async function stop(base, promptId) {
    try {
      const where = await position(base, promptId)
      if (where === 'queued') await call(base, '/queue', { method: 'POST', body: JSON.stringify({ delete: [promptId] }), headers: { 'Content-Type': 'application/json' } })
      else if (where === 'running') await call(base, '/interrupt', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } })
    } catch { /* The job may still finish on its own; nothing is collected. */ }
  }

  // The one finished file of the kind this workflow makes: a clip, or a PNG picture.
  function findResult(outputs, types) {
    for (const node of Object.values(plain(outputs) ? outputs : {})) {
      for (const key of ['videos', 'gifs', 'images']) {
        for (const item of Array.isArray(node?.[key]) ? node[key] : []) {
          const extension = typeof item?.filename === 'string' ? item.filename.slice(item.filename.lastIndexOf('.')).toLowerCase() : ''
          if (!Object.hasOwn(types, extension) || item.type !== 'output' || !/^[A-Za-z0-9 ._-]{1,200}$/.test(item.filename) || item.filename.includes('..')
            || typeof item.subfolder !== 'string' || !/^[A-Za-z0-9 ._/-]{0,200}$/.test(item.subfolder) || item.subfolder.includes('..') || item.subfolder.startsWith('/')) continue
          return { filename: item.filename, subfolder: item.subfolder, mimeType: types[extension], extension }
        }
      }
    }
    return null
  }

  // Would this bound graph run entirely on this computer, with the files it has? Used before an owner adds a workflow of their own.
  async function check(workflow) {
    const base = loopback(await getEndpoint())
    const info = await call(base, '/object_info', { maxBytes: LIMITS.objectInfoBytes })
    if (!info.ok || !plain(info.value)) throw refuse('ComfyUI on this computer did not answer.', 'GPU_SHARE_COMFY_UNAVAILABLE')
    return judge(workflow, info.value)
  }

  async function run({ jobId, workflowId, choices, image, signal, onStatus = () => {}, own = null } = {}) {
    if (!safeJobId(jobId)) throw refuse('This job has no valid id.')
    const tell = (status, extra = {}) => { try { onStatus({ jobId, status, ...extra }) } catch { /* Status is display only. */ } }
    const stopped = () => signal?.aborted === true
    const { entry, base, template, objectInfo } = await prepared(workflowId, own)
    const checked = entry.normalize(choices)
    if (entry.needsImage) checkImage(image)
    if (stopped()) throw refuse('The job was stopped before it started.', 'GPU_SHARE_STOPPED')
    tell('preparing')
    // A workflow whose picture loader is switched out still needs a file to load: a small grey placeholder.
    const imageName = entry.needsImage ? await uploadImage(base, image) : entry.placeholderImage ? await uploadImage(base, PLACEHOLDER_IMAGE) : null
    const bound = entry.bind(template, checked, { imageName, prefix: `velorn_network/${jobId}`, randomSeed })
    const verdict = judge(bound.workflow, objectInfo)
    if (!verdict.ok) throw Object.assign(refuse(verdict.reason, verdict.code), { missingModels: verdict.missingModels, unknownNodes: verdict.unknownNodes })
    if (stopped()) throw refuse('The job was stopped before it started.', 'GPU_SHARE_STOPPED')
    const queued = await call(base, '/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: bound.workflow, client_id: `velorn-network-${jobId}` }) })
    const promptId = queued.value?.prompt_id
    if (!queued.ok || typeof promptId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(promptId)) throw refuse('ComfyUI did not accept the job.', 'GPU_SHARE_COMFY_FAILED')
    tell('queued')
    const started = now()
    let last = 'queued', misses = 0
    for (;;) {
      if (stopped()) { await stop(base, promptId); throw refuse('The job was stopped.', 'GPU_SHARE_STOPPED') }
      if (now() - started > maxRunMs) { await stop(base, promptId); throw refuse('The job took too long and was stopped.', 'GPU_SHARE_TIMEOUT') }
      await sleep(pollMs)
      let history
      try { history = await call(base, `/history/${encodeURIComponent(promptId)}`) } catch { history = null }
      const record = plain(history?.value) ? history.value[promptId] : null
      if (plain(record)) {
        const state = String(record.status?.status_str || '').toLowerCase()
        if (['error', 'failed', 'cancelled', 'interrupted'].includes(state)) throw refuse(state === 'error' || state === 'failed' ? 'ComfyUI could not finish the job.' : 'The job was stopped.', state === 'error' || state === 'failed' ? 'GPU_SHARE_COMFY_FAILED' : 'GPU_SHARE_STOPPED')
        if (state === 'success' || state === 'completed' || record.status?.completed === true) {
          const picture = entry.kind === 'image'
          const found = findResult(record.outputs, picture ? IMAGE : VIDEO)
          if (!found) throw refuse(`ComfyUI finished but there was no ${picture ? 'picture' : 'video'} to collect.`, 'GPU_SHARE_COMFY_FAILED')
          tell('collecting')
          const query = new URLSearchParams({ filename: found.filename, subfolder: found.subfolder, type: 'output' })
          const file = await call(base, `/view?${query}`, { binary: true, timeoutMs: LIMITS.downloadMs, maxBytes: LIMITS.resultBytes })
          if (!file.ok || file.bytes.length < 12) throw refuse(`The finished ${picture ? 'picture' : 'video'} could not be read from ComfyUI.`, 'GPU_SHARE_COMFY_FAILED')
          if (picture ? !file.bytes.subarray(0, 8).equals(PNG) : found.extension !== '.webm' && file.bytes.toString('ascii', 4, 8) !== 'ftyp') throw refuse(`The finished file is not a ${picture ? 'picture' : 'video'}.`, 'GPU_SHARE_COMFY_FAILED')
          return { jobId, workflowId: entry.id, bytes: file.bytes, mimeType: found.mimeType, filename: `velorn-network-${jobId}${found.extension}`,
            ...(bound.width ? { width: bound.width, height: bound.height } : {}), ...(picture ? {} : { seconds: bound.seconds, fps: bound.fps }), seed: bound.seed }
        }
      }
      let where = 'unknown'
      try { where = await position(base, promptId) } catch { where = 'unknown' }
      if (where === 'none' && !plain(record)) { if (++misses >= 3) throw refuse('ComfyUI lost track of the job.', 'GPU_SHARE_COMFY_FAILED') } else misses = 0
      if ((where === 'running' || where === 'queued') && where !== last) { last = where; tell(where) }
    }
  }

  return { capability, check, run }
}

module.exports = { createGpuShareHostRunner, LIMITS }
