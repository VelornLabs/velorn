// Keyframes made in the cloud through Comfy Router, as one batch.
//
// Each shot sends its keyframe words and up to three reference pictures (the
// people in the shot, and its place). The whole batch gets one price and one
// approval (electron/comfyRouter.cjs, previewCreateBatch). Pure helpers: the
// screen supplies the pictures and the calls.
export const KEYFRAME_BATCH_MAX = 200
export const KEYFRAME_REFERENCES_MAX = 3

// The model is told what the attached pictures are for, and what they are not
// for. An earlier wording, "keep the people and the place exactly as they look
// in the reference picture", made it hand the place picture straight back:
// four runs of one shot came out as copies of the place picture, whatever the
// seed or the words (seen 2026-11-12). The script's own place hint ("Keep the
// same place as the reference picture of ...") is taken out for the same reason.
const PLACE_HINT = /\s*Keep the same place as the reference picture of [^.]*\./gi

export function keyframeText(prompt, referenceCount) {
  const words = String(prompt || '').replace(PLACE_HINT, '').replace(/\s+/g, ' ').trim()
  if (!words) return ''
  const many = referenceCount !== 1
  // The instruction comes FIRST: these models weigh the start of the text
  // most, and at the end of a long description it barely moved the camera.
  return referenceCount > 0
    ? `Use the attached ${many ? 'pictures' : 'picture'} only as a reference for what the place and the people look like. Do not copy ${many ? 'their' : 'its'} camera position or composition. Make a new picture, from a new camera position, of this: ${words} One single picture, no text, no border.`
    : `${words} One single picture, no text, no border.`
}

// Turns shots into the batch the Router takes. A picture used by many shots is
// loaded and sent once. `loadPicture(assetId)` returns { mimeType, base64 } or null.
export async function buildKeyframeBatch({ rows, loadPicture, shape = 'landscape', size = '2K' }) {
  const ids = new Map() // asset id -> picture id
  const pictures = {}
  const items = []
  const kept = []
  const skipped = []
  for (const row of (Array.isArray(rows) ? rows : []).slice(0, KEYFRAME_BATCH_MAX)) {
    const pictureIds = []
    for (const assetId of [...new Set((row.assetIds || []).filter(Boolean))].slice(0, KEYFRAME_REFERENCES_MAX)) {
      if (!ids.has(assetId)) {
        const picture = await loadPicture(assetId)
        if (!picture) continue
        const id = `p${ids.size}`
        ids.set(assetId, id)
        pictures[id] = picture
      }
      pictureIds.push(ids.get(assetId))
    }
    const prompt = keyframeText(row.prompt, pictureIds.length)
    if (!prompt) { skipped.push(row); continue }
    items.push({ prompt: prompt.slice(0, 4000), shape, size, pictureIds })
    kept.push(row)
  }
  return { items, pictures, rows: kept, skipped, leftOut: Math.max(0, (rows?.length || 0) - KEYFRAME_BATCH_MAX) }
}

// Runs jobs a few at a time and reports each result as it lands.
export async function runFewAtATime(jobs, worker, limit = 4) {
  const results = new Array(jobs.length)
  let next = 0
  const lane = async () => {
    while (next < jobs.length) {
      const index = next++
      try { results[index] = await worker(jobs[index], index) } catch (error) { results[index] = { success: false, error: error?.message || 'Something went wrong.' } }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, jobs.length)) }, lane))
  return results
}
