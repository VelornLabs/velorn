'use strict'
const { randomUUID } = require('node:crypto')
const REVIEW_TOOLS = new Set(['inspect_timeline_frame', 'inspect_timeline_range', 'inspect_visible_shots', 'inspect_source_frame', 'inspect_clip'])
function validReviewImage(dataUrl, max = 1100000) {
  if (typeof dataUrl !== 'string' || dataUrl.length > max) return false
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl)
  if (!match || match[2].length % 4) return false
  const bytes = Buffer.from(match[2], 'base64')
  if (bytes.toString('base64') !== match[2]) return false
  return match[1] === 'jpeg' ? bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217
    : match[1] === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      : bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP'
}
function reviewFrames(name, result) {
  if (!REVIEW_TOOLS.has(name) || result?.isError) return []
  let metadata
  try { metadata = JSON.parse(result.content.find(item => item.type === 'text').text) } catch { return [] }
  if (metadata.success === false || metadata.result?.success === false) return []
  const timeline = name === 'inspect_timeline_frame'
  const source = name === 'inspect_source_frame'
  const time = timeline ? metadata.frame?.timeSeconds : source ? metadata.result?.timelineSeconds : undefined
  const timelineId = timeline ? metadata.timeline?.id : source ? metadata.result?.context?.timelineId : undefined
  const type = timeline ? `Timeline frame${metadata.capture?.renderer === 'legacy' ? ' · simplified render' : ''}` : source ? 'Source frame · no effects' : name === 'inspect_clip' ? 'Source image / poster · no effects' : 'Timeline review · sampled frames'
  return (result.content || []).filter(item => item.type === 'image').slice(0, 4).flatMap(item => {
    const dataUrl = `data:${item.mimeType};base64,${item.data}`
    if (!validReviewImage(dataUrl)) return []
    return [{ id: `review-${randomUUID()}`, dataUrl, label: type, capturedAt: Date.now(),
      ...(Number.isFinite(time) && time >= 0 && typeof timelineId === 'string' ? { timeSeconds: time, timelineId } : {}) }]
  })
}
module.exports = { reviewFrames, validReviewImage }
