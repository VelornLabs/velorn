// Composer attachments are explicit, per-message shares, never project imports
// or persisted conversation content. Native IPC validates them independently.
export const ATTACHMENT_LIMITS = Object.freeze({ count: 4, imageInputBytes: 12 * 1024 * 1024,
  imageBytes: 768 * 1024, jsonBytes: 128 * 1024, jsonTotalBytes: 256 * 1024 })
const encoder = new TextEncoder()
export function attachmentName(value) {
  return String(value || 'attachment').split(/[\\/]/).at(-1).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120) || 'attachment'
}
export function attachmentKind(file) {
  if (/\.(json)$/i.test(file.name || '') && ['', 'application/json', 'text/json', 'text/plain', 'application/octet-stream'].includes(file.type || '')) return 'json'
  if (['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return 'image'
  throw new Error('Attach PNG, JPEG, WebP images or .json files. Other file types are not supported.')
}
export function validateAttachmentJson(text) {
  if (encoder.encode(text).byteLength > ATTACHMENT_LIMITS.jsonBytes) throw new Error('Each JSON attachment must be 128 KiB or smaller.')
  let value
  try { value = JSON.parse(text) } catch { throw new Error('The JSON attachment is not valid JSON.') }
  if (!value || typeof value !== 'object') throw new Error('Attach a JSON object or array.')
  let nodes = 0
  function inspect(item, depth) {
    if (++nodes > 20000 || depth > 40) throw new Error('The JSON attachment is too complex.')
    if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('The JSON attachment contains an unsafe object key.')
      inspect(child, depth + 1)
    }
  }
  inspect(value, 0)
  return text
}
export function checkAttachmentBatch(items) {
  if (items.length > ATTACHMENT_LIMITS.count) throw new Error('Attach at most four files per message.')
  if (items.filter(item => item.kind === 'json').reduce((sum, item) => sum + encoder.encode(item.text).byteLength, 0) > ATTACHMENT_LIMITS.jsonTotalBytes) throw new Error('JSON attachments together must be 256 KiB or smaller.')
  return items
}
export async function readChatAttachment(file) {
  const kind = attachmentKind(file), name = attachmentName(file.name)
  if (kind === 'json') {
    if (file.size > ATTACHMENT_LIMITS.jsonBytes) throw new Error('Each JSON attachment must be 128 KiB or smaller.')
    return { id: crypto.randomUUID(), kind, name, text: validateAttachmentJson(await file.text()) }
  }
  if (file.size > ATTACHMENT_LIMITS.imageInputBytes) throw new Error('Each source image must be 12 MiB or smaller.')
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { img.src = ''; reject(new Error('Image attachment timed out.')) }, 10000)
      img.onload = () => { clearTimeout(timer); resolve() }
      img.onerror = () => { clearTimeout(timer); reject(new Error('The image attachment could not be decoded.')) }
      img.src = url
    })
    if (!img.naturalWidth || !img.naturalHeight || img.naturalWidth * img.naturalHeight > 64 * 1024 * 1024) throw new Error('The image attachment has invalid or excessive dimensions.')
    const scale = Math.min(1, 1536 / Math.max(img.naturalWidth, img.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    let dataUrl = canvas.toDataURL('image/jpeg', .82)
    if ((dataUrl.length - dataUrl.indexOf(',') - 1) * 3 / 4 > ATTACHMENT_LIMITS.imageBytes) dataUrl = canvas.toDataURL('image/jpeg', .6)
    if ((dataUrl.length - dataUrl.indexOf(',') - 1) * 3 / 4 > ATTACHMENT_LIMITS.imageBytes) throw new Error('This image is too detailed for the attachment limit. Try a smaller image.')
    return { id: crypto.randomUUID(), kind, name, dataUrl }
  } finally { URL.revokeObjectURL(url) }
}
