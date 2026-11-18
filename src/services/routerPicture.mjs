// One picture through Comfy Router, for the Director's cast and places.
//
// The same route the Create tab uses: ask Comfy for the price, send the request
// on the person's click (that click is the approval for a small priced job),
// wait for it, then save the picture into the project. Nothing is sent before
// the click, and a request is never sent a second time on its own.
export const ROUTER_PICTURE_MODEL_ID = 'nano-banana-2-1'
export const ROUTER_PICTURE_SIZE = '2K'

const NOT_CONNECTED = new Set(['COMFY_ROUTER_KEY_REQUIRED', 'COMFY_ROUTER_AUTH'])

export function routerPictureProblem(answer) {
  if (NOT_CONNECTED.has(answer?.code)) return 'Connect your Comfy account first. Open the Create tab and follow the steps there, then come back.'
  if (answer?.code === 'COMFY_ROUTER_CREDITS' || /credit/i.test(String(answer?.error || ''))) return 'Your Comfy account is out of credits.'
  return answer?.error || 'Comfy could not make this picture.'
}

// What the picture model is called and what a picture costs, read from
// Velorn's own list. No key and no network are needed.
export async function routerPictureModel(api) {
  if (!api?.models) return null
  let listed = null
  try { listed = await api.models({}) } catch { return null }
  if (!listed?.success) return null
  const images = (listed.models || []).filter((model) => model.kind === 'image')
  const model = images.find((entry) => entry.id === ROUTER_PICTURE_MODEL_ID) || images.find((entry) => entry.default) || images[0]
  if (!model) return null
  const hasWantedSize = model.usdPerImage?.[ROUTER_PICTURE_SIZE] != null
  return {
    id: model.id,
    name: model.name,
    usd: hasWantedSize ? model.usdPerImage[ROUTER_PICTURE_SIZE] : (model.usdPerImage?.['1K'] ?? null),
    size: hasWantedSize ? ROUTER_PICTURE_SIZE : '1K',
    creditsPerUsd: listed.creditsPerUsd || null,
  }
}

// Step 1: the price. Sends nothing that costs money.
export async function quoteRouterPicture({ api, modelId, size, prompt, shape = 'landscape' }) {
  if (!api?.previewCreate) return { success: false, error: 'Cloud pictures need the Velorn desktop app.' }
  const text = String(prompt || '').trim()
  if (!text) return { success: false, error: 'Describe the picture first.' }
  let plan = null
  try { plan = await api.previewCreate({ modelId, choices: { prompt: text, shape, size } }) } catch (error) { plan = { success: false, error: error?.message } }
  if (!plan?.success) return { success: false, code: plan?.code, error: routerPictureProblem(plan) }
  return { success: true, planId: plan.planId, usd: plan.estimate?.usd ?? null, firm: Boolean(plan.estimate?.firm), clickApproves: Boolean(plan.buttonApproval) }
}

// Step 2: send it. Call this straight from the click.
export async function sendRouterPicture({ api, planId }) {
  let sent = null
  try { sent = await api.submitCreate({ planId }) } catch { return { success: false, error: 'Press the button once more to send it.' } }
  if (!sent?.success) return { success: false, code: sent?.code, error: routerPictureProblem(sent) }
  const job = sent.jobs?.[0] || sent.job
  if (!job?.jobId) return { success: false, error: 'Comfy did not confirm the request.' }
  return { success: true, jobId: job.jobId }
}

// Step 3: wait for it and save it into the project.
export async function collectRouterPicture({ api, jobId, importImage, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), isCancelled = () => false, maxMisses = 6 }) {
  let misses = 0
  let delay = 2500
  while (!isCancelled()) {
    await wait(delay)
    let answer = null
    try { answer = await api.refresh({ jobId }) } catch { answer = null }
    if (!answer?.success) {
      if (++misses < maxMisses && !NOT_CONNECTED.has(answer?.code)) continue
      return { success: false, error: 'Velorn lost touch with Comfy. The picture may still have been made: check your Comfy usage page before trying again, or you could pay twice.' }
    }
    misses = 0
    const job = answer.job
    delay = Math.max(2500, Math.min(job?.retryAfterMs || 2500, 15000))
    if (job?.status === 'COMPLETED') {
      const saved = await importImage(jobId, { previewOnly: false })
      if (!saved?.success) return { success: false, error: saved?.error || 'The picture was made but could not be added to your project. It stays on Comfy for 24 hours.' }
      return { success: true, assetId: saved.assetId }
    }
    if (['FAILED', 'CANCELLED', 'UNCERTAIN'].includes(job?.status)) return { success: false, error: job?.error || 'Comfy could not make this picture.' }
  }
  return { success: false, cancelled: true, error: 'Stopped waiting.' }
}

export const dollars = (usd) => (usd == null ? '' : `$${Number(usd).toFixed(2)}`)
