'use strict'

// This adapter controls ONLY models selected by the connected local agent. It
// never unloads all models, scans disk, downloads weights or accepts an API URL
// supplied by a tool result. Instance IDs and load settings come from LM Studio.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f]/.test(value)
function failure(message) {
  return Object.assign(new Error(message), { code: 'LOCAL_GPU_RUNTIME_UNAVAILABLE', publicMessage: message })
}
function endpointOrigin(endpoint) {
  let url
  try { url = new URL(endpoint) } catch { throw failure('Choose the local LM Studio server before using GPU sharing.') }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.port !== '1234' || !['/v1', '/v1/'].includes(url.pathname) || url.username || url.password || url.search || url.hash) {
    throw failure('GPU sharing supports only the configured local LM Studio server on port 1234.')
  }
  return `http://${url.hostname === 'localhost' ? '127.0.0.1' : url.hostname}:1234`
}
function abortCheck(signal) {
  if (signal?.aborted) throw Object.assign(new Error('Local model operation cancelled.'), { code: 'CANCELLED' })
}
function savedConfig(config) {
  const result = {}
  if (!object(config)) return result
  for (const key of ['context_length', 'eval_batch_size', 'num_experts']) {
    if (Number.isSafeInteger(config[key]) && config[key] > 0 && config[key] <= 1048576) result[key] = config[key]
  }
  for (const key of ['flash_attention', 'offload_kv_cache_to_gpu']) if (typeof config[key] === 'boolean') result[key] = config[key]
  return result
}

function createLocalAgentModelRuntime({ fetchImpl = globalThis.fetch, requestTimeoutMs = 15000, loadTimeoutMs = 120000, modelProfiles = {} } = {}) {
  const suspended = new Map()
  async function request(origin, route, { body, signal, timeoutMs = requestTimeoutMs } = {}) {
    abortCheck(signal)
    const controller = new AbortController()
    const cancel = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
    const timer = setTimeout(() => controller.abort('timeout'), timeoutMs)
    let abortRequest
    const cancelled = new Promise((_, reject) => {
      abortRequest = () => reject(failure('Local model memory management was interrupted. Check LM Studio before retrying.'))
      controller.signal.addEventListener('abort', abortRequest, { once: true })
      if (controller.signal.aborted) abortRequest()
    })
    let reader
    try {
      const response = await Promise.race([cancelled, fetchImpl(`${origin}/api/v1/models${route}`, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: controller.signal,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })])
      if (!response.ok) throw failure('LM Studio could not confirm the GPU handoff. Check its local server and model-management support before retrying.')
      const chunks = []; let bytes = 0
      if (!response.body) throw failure('LM Studio returned no model-management response.')
      reader = response.body.getReader()
      while (true) {
        const { done, value: chunk } = await Promise.race([cancelled, reader.read()])
        if (done) break
        abortCheck(signal)
        bytes += chunk.byteLength
        if (bytes > 1024 * 1024) throw failure('LM Studio returned an oversized model-management response.')
        chunks.push(Buffer.from(chunk))
      }
      abortCheck(signal)
      let data
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw failure('LM Studio returned an invalid model-management response.') }
      if (!object(data)) throw failure('LM Studio returned an invalid model-management response.')
      return data
    } catch (error) {
      abortCheck(signal)
      if (error?.code === 'LOCAL_GPU_RUNTIME_UNAVAILABLE') throw error
      throw failure('Could not confirm local model memory management. Check LM Studio on port 1234; GPU sharing will not guess that memory is free.')
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      controller.signal.removeEventListener('abort', abortRequest)
      if (reader) void reader.cancel().catch(() => {})
    }
  }
  async function models(origin, signal) {
    const body = await request(origin, '', { signal })
    if (!Array.isArray(body.models) || body.models.length > 2048) throw failure('LM Studio did not provide a valid model catalog for GPU sharing.')
    const rows = body.models.filter(row => object(row) && row.type === 'llm')
    if (rows.some(row => !validId(row.key) || !Array.isArray(row.loaded_instances)
      || row.loaded_instances.some(instance => !object(instance) || !validId(instance.id))
      || new Set(row.loaded_instances.map(instance => instance.id)).size !== row.loaded_instances.length)) {
      throw failure('LM Studio returned an invalid loaded-model identity.')
    }
    return rows
  }
  function resolve(rows, model, previous) {
    const matches = rows.filter(row => previous ? row.key === previous.key : row.key === model || row.loaded_instances.some(instance => instance?.id === model))
    if (matches.length !== 1) throw failure('The selected local model could not be identified uniquely. Refresh models in Velorn before using GPU sharing.')
    const row = matches[0]
    const instances = row.loaded_instances.filter(instance => object(instance) && validId(instance.id))
    if (instances.length !== row.loaded_instances.length) throw failure('LM Studio returned an invalid loaded-model identity.')
    // Once Velorn owns an instance, its recorded ID is authoritative. The model
    // key is not an instance identity: a sibling may use that key as its alias,
    // or be the only remaining instance after ours was unloaded for generation.
    // In either case restore our saved configuration instead of adopting it.
    if (previous) return { row, instance: instances.find(instance => instance.id === previous.instanceId) || null }
    const exact = instances.find(instance => instance.id === model)
    if (!exact && instances.length > 1) throw failure('Multiple instances of the selected local model are loaded. Select one instance before using GPU sharing.')
    return { row, instance: exact || instances[0] || null }
  }
  async function prepareModel({ model, endpoint, signal }) {
    if (!validId(model)) throw failure('Choose a local model before using GPU sharing.')
    const origin = endpointOrigin(endpoint), key = `${origin}\n${model}`
    if (!suspended.has(key) && suspended.size >= 32) throw failure('Too many local model handoffs are pending. Restart Velorn before loading more models.')
    const previous = suspended.get(key)
    let { row, instance } = resolve(await models(origin, signal), model, previous)
    const profile = Object.hasOwn(modelProfiles, row.key) ? modelProfiles[row.key] : null
    const defaultConfig = Number.isSafeInteger(profile?.contextLength) && profile.contextLength > 0
      && profile.contextLength <= 1048576 ? { context_length: profile.contextLength } : {}
    if (previous?.uncertainLoad && (!previous.instanceId || instance?.id !== previous.instanceId)) {
      throw failure('A local model load has an uncertain outcome. Check and unload it in LM Studio, then restart Velorn before continuing GPU sharing.')
    }
    if (!instance) {
      const config = { ...defaultConfig, ...(previous?.config || {}) }
      const existingInstanceIds = new Set(row.loaded_instances.map(loaded => loaded.id))
      suspended.set(key, { key: row.key, config, uncertainLoad: true })
      const loaded = await request(origin, '/load', { body: { model: row.key, ...config, echo_load_config: true }, signal, timeoutMs: loadTimeoutMs })
      if (loaded.status !== 'loaded' || !validId(loaded.instance_id)) throw failure('LM Studio did not confirm that the selected model loaded.')
      if (existingInstanceIds.has(loaded.instance_id)) throw failure('LM Studio returned a different instance that was already loaded instead of restoring the selected model. Velorn did not use or unload that instance.')
      suspended.set(key, { key: row.key, instanceId: loaded.instance_id, config, uncertainLoad: true })
      const fresh = resolve(await models(origin, signal), row.key, { key: row.key, instanceId: loaded.instance_id })
      row = fresh.row; instance = fresh.instance
      if (!instance || instance.id !== loaded.instance_id) throw failure('The restored local model could not be verified.')
    }
    if (!suspended.has(key) && suspended.size >= 32) throw failure('Too many local model handoffs are pending. Restart Velorn before loading more models.')
    suspended.set(key, { key: row.key, instanceId: instance.id, config: savedConfig(instance.config) })
    // A custom instance alias may change after reload. The host, not the model,
    // supplies this verified replacement ID to the next inference request.
    return { model: instance.id, ...(['none', 'low'].includes(profile?.reasoningEffort) ? { reasoningEffort: profile.reasoningEffort } : {}) }
  }
  async function releaseModel({ model, endpoint, signal }) {
    if (!validId(model)) throw failure('Choose a local model before using GPU sharing.')
    const origin = endpointOrigin(endpoint), key = `${origin}\n${model}`
    const previous = suspended.get(key)
    const rows = await models(origin, signal)
    if (previous?.uncertainLoad && (!previous.instanceId || !rows.some(row => row.key === previous.key && row.loaded_instances.some(instance => instance.id === previous.instanceId)))) {
      throw failure('A local model load has an uncertain outcome. Check and unload it in LM Studio, then restart Velorn before starting generation.')
    }
    // Once owned, never adopt another client's replacement instance just
    // because it uses the same weights. Only prepareModel may claim a new ID.
    if (previous && !rows.some(row => row.key === previous.key && row.loaded_instances.some(instance => instance.id === previous.instanceId))) return { released: true }
    const { row, instance } = resolve(rows, model, previous)
    if (!instance) return { released: true }
    if (!suspended.has(key) && suspended.size >= 32) throw failure('Too many local model handoffs are pending. Restart Velorn before loading more models.')
    // Save before POST: cancellation can race an already accepted unload. A
    // later preparation rechecks actual state, never repeats a generation.
    suspended.set(key, { key: row.key, instanceId: instance.id, config: savedConfig(instance.config) })
    const result = await request(origin, '/unload', { body: { instance_id: instance.id }, signal })
    if (result.instance_id !== instance.id) throw failure('LM Studio did not confirm the selected model was unloaded.')
    const fresh = await models(origin, signal)
    if (fresh.some(item => item.loaded_instances.some(loaded => loaded?.id === instance.id))) {
      throw failure('The selected local model is still loaded. Generation is paused until LM Studio releases it.')
    }
    return { released: true }
  }
  return { prepareModel, releaseModel }
}

module.exports = { createLocalAgentModelRuntime, endpointOrigin, savedConfig }
