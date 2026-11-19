// Every app-managed ComfyUI submission crosses this native boundary. There is
// deliberately no direct-fetch or old-preload fallback: that would bypass the
// spending decision. The native host owns policy, consent and credential use.
// `priced`: the person clicked a button that shows the price. The native host still
// decides whether that click is enough; it only is for the Sound tab's own requests.
// `batchCount`: how many generations like this one are waiting, this one included,
// so the native host can offer one approval for all of them.
export async function submitManagedGeneration({ workflow, endpoint, clientId, priced = false, batchCount = 0 }, api = globalThis.window?.electronAPI?.generationSpending) {
  if (typeof api?.queue !== 'function') {
    throw Object.assign(new Error('Generation spending protection is unavailable. Fully quit and reopen Velorn before generating. Browser-only previews cannot submit generations.'), { code: 'GENERATION_SPENDING_UNAVAILABLE' })
  }
  const requestId = globalThis.crypto.randomUUID()
  let result
  try { result = await (priced && typeof api.queuePriced === 'function' ? api.queuePriced : api.queue)({ requestId, endpoint, workflow, clientId,
    ...(Number.isInteger(batchCount) && batchCount >= 2 ? { batchCount: Math.min(batchCount, 200) } : {}) }) }
  catch {
    // A lost IPC reply cannot establish whether the server accepted the POST.
    // Never fall back to HTTP, repeat the call, or carry on with a waiting batch.
    throw Object.assign(new Error('The generation connection ended without a confirmed result. Inspect ComfyUI queue/history before trying again, and restart Velorn if its native bridge is unavailable.'), {
      code: 'GENERATION_SPENDING_UNCERTAIN', submissionState: 'unknown', retryAllowed: false,
    })
  }
  if (result?.success !== true) {
    throw Object.assign(new Error(result?.error || 'Generation was not submitted. Check Generation spending in Assistant settings.'), {
      code: result?.code || 'GENERATION_SPENDING_FAILED',
      submissionState: result?.submissionState,
      generationSubmitted: result?.submissionState === 'not-started' ? false : undefined,
      retryAllowed: result?.retryAllowed,
    })
  }
  if (!Number.isInteger(result.status) || typeof result.ok !== 'boolean') {
    throw Object.assign(new Error('The generation response could not be verified. Inspect ComfyUI history before trying again.'), { code: 'GENERATION_SPENDING_UNCERTAIN', submissionState: 'unknown', retryAllowed: false })
  }
  if (result.ok && (typeof result.body?.prompt_id !== 'string' || !result.body.prompt_id || result.body.prompt_id.length > 256)) {
    throw Object.assign(new Error('ComfyUI did not confirm a prompt ID. The workflow may have been submitted; inspect the queue or history before trying again.'), { code: 'GENERATION_SPENDING_UNCERTAIN', submissionState: 'unknown', retryAllowed: false })
  }
  // Preserve ComfyUI's existing validation/insufficient-credit error handling.
  return { ok: result.ok, status: result.status,
    json: async () => result.body,
    text: async () => typeof result.body === 'string' ? result.body : JSON.stringify(result.body),
  }
}
