'use strict'

// This is an in-process handoff, not a GPU/global ComfyUI lock. Other ComfyUI
// clients can submit between our final queue probe and /free or model loading.
// Never interrupt their jobs, infer completion from an empty queue alone, or
// automatically resubmit a prompt whose POST outcome is unknown.
const RELEASED_TORCH_BYTES = 256 * 1024 * 1024
const PREEMPT = Symbol('generation-priority')

function failure(code, message) {
  return Object.assign(new Error(message), { code, publicMessage: message })
}
function abortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : Object.assign(new Error('Local GPU handoff cancelled.'), { name: 'AbortError' })
}
function endpointBase(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.pathname !== '/' || url.username || url.password || url.search || url.hash) return null
    return url.href.replace(/\/+$/, '')
  } catch { return null }
}
function queueIdle(body) {
  if (!body || !Array.isArray(body.queue_running) || !Array.isArray(body.queue_pending)) {
    throw failure('LOCAL_GPU_COMFY_UNAVAILABLE', 'ComfyUI did not return a valid queue. Check its connection before retrying the local agent.')
  }
  return body.queue_running.length === 0 && body.queue_pending.length === 0
}
function terminalHistory(body, id) {
  const status = body?.[id]?.status
  return status?.completed === true || ['success', 'completed', 'error', 'failed', 'cancelled', 'interrupted'].includes(status?.status_str)
}
function memoryState(body) {
  if (!body || !Array.isArray(body.devices) || body.devices.length === 0) return null
  if (body.devices.some(device => device?.type !== 'cpu' && (
    typeof device?.torch_vram_total !== 'number' || !Number.isFinite(device.torch_vram_total) || device.torch_vram_total < 0
  ))) return null
  return body.devices.every(device => device?.type === 'cpu' || device.torch_vram_total <= RELEASED_TORCH_BYTES)
}
function rejectedPrompt(result, promptId) {
  const error = result?.body?.error
  const describedError = typeof error === 'string' ? Boolean(error.trim())
    : error && !Array.isArray(error) && typeof error === 'object'
      && ((typeof error.message === 'string' && Boolean(error.message.trim())) || (typeof error.type === 'string' && Boolean(error.type.trim())))
  // A complete native ComfyUI validation response proves rejection. A network
  // error, partial body, 5xx, or contradictory prompt ID does not prove that.
  return result?.success === true && result?.ok === false && result?.status === 400 && describedError && promptId == null
}

function createLocalAgentGpuCoordinator({
  getComfyEndpoint = () => null, runtime, fetchImpl = globalThis.fetch,
  pollMs = 1000, requestTimeoutMs = 5000, maxWaitMs = 30 * 60 * 1000,
} = {}) {
  if (typeof runtime?.releaseModel !== 'function' || typeof runtime?.prepareModel !== 'function') throw new TypeError('A local model runtime is required.')
  const lifetime = new AbortController()
  const generations = [], inferences = [], leases = new Map(), ownedModels = new Map(), preparingModels = new Map(), busyEndpoints = new Set()
  let active = null, nextLease = 0, disposed = false
  const interval = Math.max(1, Number(pollMs) || 1000)
  const requestLimit = Math.max(1, Number(requestTimeoutMs) || 5000)
  const waitLimit = Math.max(1, Number(maxWaitMs) || 30 * 60 * 1000)

  function check(ctx) {
    if (ctx.signal.aborted) throw abortError(ctx.signal)
    if (disposed) throw failure('LOCAL_GPU_DISPOSED', 'The local GPU coordinator has closed. Restart Velorn before retrying.')
  }
  function waiting(ctx, value, message) {
    if (ctx.waiting !== value) {
      ctx.waiting = value
      try { ctx.onWaiting?.(value) } catch {}
    }
    if (value && message && ctx.lastMessage !== message && !ctx.signal.aborted) {
      ctx.lastMessage = message
      try { ctx.onEvent?.({ type: 'status', text: message }) } catch {}
    }
  }
  function pause(ctx) {
    check(ctx)
    return new Promise((resolve, reject) => {
      const finish = error => { clearTimeout(timer); ctx.signal.removeEventListener('abort', abort); error ? reject(error) : resolve() }
      const abort = () => finish(abortError(ctx.signal))
      const timer = setTimeout(() => finish(), interval)
      ctx.signal.addEventListener('abort', abort, { once: true })
    })
  }
  async function request(ctx, endpoint, route, method = 'GET', body) {
    check(ctx)
    const controller = new AbortController()
    const abort = () => controller.abort(abortError(ctx.signal))
    ctx.signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => controller.abort(failure('LOCAL_GPU_COMFY_UNAVAILABLE', 'ComfyUI did not respond during the GPU handoff. Check its connection before retrying.')), requestLimit)
    let cancel
    const cancelled = new Promise((_, reject) => {
      cancel = () => reject(abortError(controller.signal))
      controller.signal.addEventListener('abort', cancel, { once: true })
    })
    try {
      const value = await Promise.race([cancelled, (async () => {
        const response = await fetchImpl(`${endpoint}${route}`, {
          method, signal: controller.signal, cache: 'no-store', redirect: 'error',
          ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
        })
        if (!response.ok) throw failure('LOCAL_GPU_COMFY_UNAVAILABLE', 'ComfyUI refused a GPU handoff check. Check its connection before retrying.')
        // ComfyUI /free intentionally returns an empty HTTP 200 body.
        return method === 'POST' ? null : response.json()
      })()])
      check(ctx)
      return value
    } finally {
      clearTimeout(timer)
      ctx.signal.removeEventListener('abort', abort)
      controller.signal.removeEventListener('abort', cancel)
    }
  }
  function yieldToGeneration(ctx) {
    check(ctx)
    if (generations.some(item => !item.signal.aborted)) throw PREEMPT
  }
  async function restoreGpu(ctx, endpoint) {
    let freeRequested = false, confirmations = 0
    while (true) {
      yieldToGeneration(ctx)
      const records = [...leases.values()].filter(record => record.endpoint === endpoint)
      const uncertain = records.find(record => record.state === 'unknown')
      if (uncertain) throw uncertain.error
      const idle = queueIdle(await request(ctx, endpoint, '/queue'))
      yieldToGeneration(ctx)
      if (!idle) {
        busyEndpoints.add(endpoint)
        freeRequested = false; confirmations = 0
        waiting(ctx, true, 'Waiting for ComfyUI generation to finish before restoring the local agent…')
        await pause(ctx)
        continue
      }
      let terminal = true
      for (const record of records) {
        if (record.state === 'submitting' || !terminalHistory(await request(ctx, endpoint, `/history/${encodeURIComponent(record.promptId)}`), record.promptId)) {
          terminal = false
        }
      }
      yieldToGeneration(ctx)
      if (!terminal) {
        waiting(ctx, true, 'Waiting for ComfyUI to confirm the submitted generation has finished…')
        await pause(ctx)
        continue
      }
      if (!busyEndpoints.has(endpoint) && !records.length) {
        // A restarted Velorn or an external client's completed generation may
        // leave an idle ComfyUI holding VRAM without any in-process job record.
        let state = null
        try { state = memoryState(await request(ctx, endpoint, '/system_stats')) }
        catch (error) { if (ctx.signal.aborted) throw error }
        yieldToGeneration(ctx)
        if (state === true) return
        if (state === null) {
          // No observed job/retained allocation: don't make optional or offline
          // ComfyUI a hard dependency for ordinary editing/chat. Be explicit
          // that this fallback is not a confirmed GPU-memory handoff.
          waiting(ctx, true, 'ComfyUI GPU memory could not be verified; continuing without a confirmed GPU handoff.')
          return
        }
      }
      busyEndpoints.add(endpoint)
      waiting(ctx, true, 'Releasing ComfyUI GPU memory before restoring the local agent…')
      // History reads take time. Refresh immediately before this write, and
      // never free models while the observed queue contains any client's job.
      if (!freeRequested) {
        if (!queueIdle(await request(ctx, endpoint, '/queue'))) { await pause(ctx); continue }
        yieldToGeneration(ctx)
        await request(ctx, endpoint, '/free', 'POST', { unload_models: true, free_memory: true })
        freeRequested = true
        await pause(ctx)
        continue
      }
      const stats = await request(ctx, endpoint, '/system_stats')
      // /free only sets asynchronous worker flags. Require two post-ack native
      // allocator readings with fresh idle queues, not the HTTP acknowledgment.
      // A bounded residual accommodates CUDA allocator bookkeeping; this is
      // not proof that arbitrary custom nodes/drivers freed every GPU byte.
      const stillIdle = queueIdle(await request(ctx, endpoint, '/queue'))
      yieldToGeneration(ctx)
      confirmations = stillIdle && memoryState(stats) === true ? confirmations + 1 : 0
      if (!stillIdle) freeRequested = false
      if (confirmations >= 2) {
        for (const [lease, record] of leases) if (record.endpoint === endpoint) leases.delete(lease)
        busyEndpoints.delete(endpoint)
        return
      }
      ctx.timeoutCode = 'LOCAL_GPU_MEMORY_NOT_RELEASED'
      await pause(ctx)
    }
  }
  async function awaitComfy(ctx) {
    check(ctx)
    let endpoint = null
    try { endpoint = endpointBase(await getComfyEndpoint()) } catch {}
    check(ctx)
    const endpoints = new Set([...busyEndpoints, ...[...leases.values()].map(record => record.endpoint)])
    if (endpoint) endpoints.add(endpoint)
    for (const candidate of endpoints) {
      try {
        await restoreGpu(ctx, candidate)
      } catch (error) {
        if (error === PREEMPT || ctx.signal.aborted) throw error
        if (busyEndpoints.has(candidate) || [...leases.values()].some(record => record.endpoint === candidate)) {
          if (error?.publicMessage) throw error
          throw failure('LOCAL_GPU_COMFY_UNAVAILABLE', 'ComfyUI could not confirm the outstanding generation or GPU handoff. Check its queue and connection before retrying the local agent.')
        }
        // A disconnected ComfyUI must not become a dependency for plain editing
        // and chat. Once a busy period is observed, fail closed until reconciled.
      }
    }
  }
  function schedule() {
    if (active || disposed) return
    const ctx = generations.shift() || inferences.shift()
    if (!ctx) return
    if (ctx.signal.aborted) { ctx.cleanup(); schedule(); return }
    active = ctx
    ;(async () => {
      let preempted = false
      try {
        check(ctx)
        if (ctx.kind === 'generation') {
          // A prepare request can have loaded the selected model even when its
          // response/cancellation prevents prediction from starting. Keep those
          // exact candidates separate from established inference ownership,
          // but require the runtime to reconcile/unload them before generation.
          const releaseCandidates = new Map([...preparingModels, ...ownedModels])
          for (const [key, model] of releaseCandidates) {
            check(ctx)
            try { await runtime.releaseModel({ ...model, signal: ctx.signal }) }
            catch (error) {
              check(ctx)
              throw failure('LOCAL_GPU_MODEL_RELEASE_FAILED', 'The local agent model could not be unloaded. Stop its active requests or unload that model in LM Studio, then retry generation.')
            }
            check(ctx)
            ownedModels.delete(key)
            preparingModels.delete(key)
          }
          check(ctx)
          const lease = Object.freeze({ id: ++nextLease })
          leases.set(lease, { endpoint: ctx.endpoint, state: 'submitting' })
          ctx.resolve(lease)
        } else {
          waiting(ctx, true, 'Waiting for GPU access for the local agent…')
          await awaitComfy(ctx)
          yieldToGeneration(ctx)
          // Loading and prediction are bounded by the caller/runtime, not by
          // the coordinator's separate queue-wait deadline.
          clearTimeout(ctx.timeout)
          waiting(ctx, false)
          const modelKey = JSON.stringify([ctx.endpoint, ctx.model])
          preparingModels.set(modelKey, { model: ctx.model, endpoint: ctx.endpoint })
          const prepared = await runtime.prepareModel({ model: ctx.model, endpoint: ctx.endpoint, signal: ctx.signal })
          check(ctx)
          // Do not claim unrelated LM Studio models from an inventory/settings
          // read. Ownership begins only when this selected model is about to run.
          ownedModels.set(modelKey, { model: ctx.model, endpoint: ctx.endpoint })
          preparingModels.delete(modelKey)
          ctx.resolve(await ctx.operation({ signal: ctx.signal, model: prepared?.model || ctx.model,
            ...(['none', 'low'].includes(prepared?.reasoningEffort) ? { reasoningEffort: prepared.reasoningEffort } : {}) }))
        }
      } catch (error) {
        if (error === PREEMPT && !ctx.signal.aborted) { inferences.unshift(ctx); preempted = true }
        else ctx.reject(error)
      } finally {
        active = null
        if (!preempted) ctx.cleanup()
        schedule()
      }
    })()
  }
  function enqueue(kind, options, operation) {
    if (disposed) return Promise.reject(failure('LOCAL_GPU_DISPOSED', 'The local GPU coordinator has closed. Restart Velorn before retrying.'))
    const controller = new AbortController()
    const ctx = { ...options, kind, operation, signal: controller.signal, waiting: false }
    const abort = () => controller.abort(abortError(options.signal))
    const close = () => controller.abort(abortError(lifetime.signal))
    options.signal?.addEventListener('abort', abort, { once: true })
    lifetime.signal.addEventListener('abort', close, { once: true })
    if (options.signal?.aborted) abort()
    const promise = new Promise((resolve, reject) => { ctx.resolve = resolve; ctx.reject = reject })
    const cancel = () => {
      ctx.reject(abortError(ctx.signal))
      if (active !== ctx) {
        for (const queue of [generations, inferences]) {
          const index = queue.indexOf(ctx)
          if (index >= 0) queue.splice(index, 1)
        }
        ctx.cleanup()
      }
      waiting(ctx, false)
    }
    ctx.cleanup = () => {
      clearTimeout(ctx.timeout)
      options.signal?.removeEventListener('abort', abort)
      lifetime.signal.removeEventListener('abort', close)
      ctx.signal.removeEventListener('abort', cancel)
      waiting(ctx, false)
    }
    ctx.timeout = setTimeout(() => controller.abort(failure(ctx.timeoutCode || 'LOCAL_GPU_WAIT_TIMEOUT', ctx.timeoutCode === 'LOCAL_GPU_MEMORY_NOT_RELEASED'
      ? 'ComfyUI GPU memory release was not confirmed. Check ComfyUI and other GPU applications, then retry the local agent.'
      : 'Timed out waiting for GPU access. Check the ComfyUI queue and connection, then retry the local agent.')), waitLimit)
    ctx.signal.addEventListener('abort', cancel, { once: true })
    if (ctx.signal.aborted) { cancel(); return promise }
    ;(kind === 'generation' ? generations : inferences).push(ctx)
    if (kind === 'inference') waiting(ctx, true, 'Waiting for GPU access for the local agent…')
    // Reservation is synchronous; same-turn generation requests win before
    // inference can start preparing a model.
    queueMicrotask(schedule)
    return promise
  }
  return {
    withInference(options = {}, operation) {
      if (typeof operation !== 'function') return Promise.reject(new TypeError('An inference operation is required.'))
      return enqueue('inference', options, operation)
    },
    beforeGeneration({ endpoint, signal } = {}) {
      const normalized = endpointBase(endpoint)
      if (!normalized) return Promise.reject(failure('LOCAL_GPU_COMFY_UNAVAILABLE', 'A valid ComfyUI endpoint is required for local GPU handoff.'))
      return enqueue('generation', { endpoint: normalized, signal })
    },
    afterGeneration({ lease, result, postStarted } = {}) {
      const record = leases.get(lease)
      if (!record || disposed) return { tracking: false }
      if (record.state !== 'submitting') return { tracking: record.state === 'tracked', promptId: record.promptId }
      if (postStarted === false || result?.submissionState === 'not-started') {
        leases.delete(lease)
        return { tracking: false }
      }
      const promptId = result?.body?.prompt_id ?? result?.prompt_id ?? result?.promptId
      if (rejectedPrompt(result, promptId)) {
        leases.delete(lease)
        return { tracking: false }
      }
      if (result?.success !== false && result?.ok !== false && typeof promptId === 'string' && promptId.trim() && promptId.length <= 512) {
        Object.assign(record, { state: 'tracked', promptId })
        busyEndpoints.add(record.endpoint)
        return { tracking: true, promptId }
      }
      record.state = 'unknown'
      record.error = failure('LOCAL_GPU_GENERATION_UNCERTAIN', 'ComfyUI submission may have started, but its prompt ID was not confirmed. Inspect the ComfyUI queue/history; do not resubmit automatically. Once generation is safely stopped or finished, restart Velorn to restore the local agent.')
      busyEndpoints.add(record.endpoint)
      return { tracking: false, code: record.error.code, error: record.error.publicMessage }
    },
    dispose() {
      if (disposed) return
      disposed = true
      lifetime.abort(failure('LOCAL_GPU_DISPOSED', 'The local GPU coordinator has closed. Restart Velorn before retrying.'))
      generations.length = 0; inferences.length = 0
      leases.clear(); ownedModels.clear(); preparingModels.clear(); busyEndpoints.clear()
    },
  }
}

module.exports = { createLocalAgentGpuCoordinator }
