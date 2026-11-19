'use strict'
// Shows a picture from the project inside the agent's reply, on the computer and
// on the paired phone. Audio and video are attached as players (agentAudioReview,
// agentPlayableMedia); a picture is attached as a still: a small JPEG copy saved
// in the same review history as editor stills, bound to the turn that asked.
//
// Only two trusted tool results can do this, never model prose:
//   - import_comfy_router_image, when it added a picture to the project
//   - get_assets with showInChat:true, for the image assets it was asked to show
// The copy is made natively from the asset's own file. No path comes from a tool.
const { randomUUID } = require('node:crypto')

const TOOLS = new Set(['import_comfy_router_image', 'get_assets'])
const ID = /^[A-Za-z0-9_-]{1,110}$/
const LIMIT = 4
// agentReviewMediaStore keeps a still up to 300,000 bytes.
const STILL_BYTES = 290000

async function recordPictureReview({ name, result, origin, projectPath, store, readPicture, toJpeg, now = Date.now }) {
  if (!TOOLS.has(name) || result?.isError || !projectPath || typeof store?.saveFrame !== 'function'
    || typeof readPicture !== 'function' || typeof toJpeg !== 'function'
    || ![origin?.chatId, origin?.turnId].every(id => typeof id === 'string' && ID.test(id))) return 0
  let value
  try { value = JSON.parse(result.content.find(item => item.type === 'text').text) } catch { return 0 }
  if (value?.success === false) return 0
  value = value?.result || value
  if (!value || value.success === false || value.previewOnly === true) return 0
  const wanted = []
  if (name === 'import_comfy_router_image') {
    if (typeof value.assetId === 'string') wanted.push({ id: value.assetId, label: 'Picture' })
  } else if (value.reviewMedia === true) {
    const names = new Map((Array.isArray(value.assets) ? value.assets : []).filter(asset => asset?.type === 'image').map(asset => [asset.id, asset.name]))
    for (const id of Array.isArray(value.pictureAssetIds) ? value.pictureAssetIds : []) {
      if (names.has(id)) wanted.push({ id, label: typeof names.get(id) === 'string' && names.get(id) ? `Picture: ${names.get(id)}`.slice(0, 150) : 'Picture' })
    }
  }
  let saved = 0
  for (const item of wanted.filter(entry => ID.test(entry.id)).slice(0, LIMIT)) {
    try {
      // readPicture accepts only an image asset of the open project, inside its folder.
      const picture = await readPicture({ assetId: item.id })
      const jpeg = await toJpeg(Buffer.from(picture.base64, 'base64'), STILL_BYTES)
      if (!Buffer.isBuffer(jpeg) || jpeg.length < 4 || jpeg.length > STILL_BYTES) continue
      await store.saveFrame(projectPath, { id: `review-${randomUUID()}`, chatId: origin.chatId, turnId: origin.turnId,
        label: item.label, capturedAt: now(), dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}` })
      saved++
    } catch { /* A picture that cannot be read or shrunk is simply not shown; the asset itself is untouched. */ }
  }
  return saved
}

// The shrinking itself, with Electron's own image code: at most `longSide` pixels,
// stepping the size and quality down until the copy fits.
function createStillMaker(nativeImage) {
  return function toJpeg(bytes, maxBytes) {
    const image = nativeImage.createFromBuffer(bytes)
    if (image.isEmpty()) return null
    const { width, height } = image.getSize()
    for (const [longSide, quality] of [[1280, 82], [1280, 70], [1024, 72], [800, 70], [640, 65]]) {
      const scale = Math.min(1, longSide / Math.max(width, height))
      const resized = scale < 1 ? image.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 'best' }) : image
      const jpeg = resized.toJPEG(quality)
      if (jpeg.length <= maxBytes) return jpeg
    }
    return null
  }
}

module.exports = { recordPictureReview, createStillMaker, STILL_BYTES, LIMIT }
