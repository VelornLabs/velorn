'use strict'
const fs = require('node:fs/promises')
const path = require('node:path')
const { constants } = require('node:fs')
const { createHash } = require('node:crypto')
const { Blob } = require('node:buffer')
const extensions = { image: /\.(png|jpg|jpeg|webp|bmp|tif|tiff)$/i, audio: /\.(wav|mp3|flac|ogg|m4a|aac|opus)$/i, video: /\.(mp4|webm|mov|mkv|avi|m4v)$/i }
const limit = 256 * 1024 * 1024
const fail = message => Object.assign(new Error(message), { code: 'WORKFLOW_ASSET_INVALID', publicMessage: message })
function localEndpoint(value) {
  const url = new URL(value)
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw fail('Reference uploads require the configured local ComfyUI connection.')
  return url.origin
}
async function uploadReceipt(response) {
  const maxBytes = 64 * 1024
  if (Number(response.headers?.get?.('content-length')) > maxBytes) {
    await response.body?.cancel?.()
    throw fail('ComfyUI returned an oversized upload receipt. No generation was queued.')
  }
  let raw
  if (response.body?.getReader) {
    const reader = response.body.getReader(), chunks = []; let size = 0, complete = false
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) { complete = true; break }
        size += value.byteLength
        if (size > maxBytes) throw fail('ComfyUI returned an oversized upload receipt. No generation was queued.')
        chunks.push(Buffer.from(value))
      }
      raw = Buffer.concat(chunks).toString('utf8')
    } finally { if (!complete) await reader.cancel().catch(() => {}); reader.releaseLock() }
  } else raw = await response.text()
  if (Buffer.byteLength(raw) > maxBytes) throw fail('ComfyUI returned an oversized upload receipt. No generation was queued.')
  return JSON.parse(raw)
}

// No caller-supplied paths. Resolve only registered, project-owned media from a
// fresh renderer snapshot. Filenames include the content hash so previews bind
// the image bytes, not merely a mutable asset ID or a machine-specific path.
function createWorkflowAssetInputs({ getSnapshot, fetchImpl = globalThis.fetch }) {
  async function read({ assetId, assetType }) {
    const snapshot = await getSnapshot()
    const project = snapshot?.project?.path
    const matches = snapshot?.assets?.filter(a => a.id === assetId) || []
    const asset = matches[0]
    if (!project || !path.isAbsolute(project) || matches.length !== 1 || !extensions[assetType]
      || asset.type !== assetType) throw fail('Reference asset is missing or has the wrong media type. Choose an existing asset from the current project.')
    const stored = asset.path || asset.absolutePath
    if (typeof stored !== 'string' || !stored || stored.includes('\0')) throw fail('Reference asset has no local file. Import it into this project first.')
    const root = await fs.realpath(project)
    const candidate = path.isAbsolute(stored) ? stored : path.resolve(root, stored.replace(/\\/g, '/'))
    const file = await fs.realpath(candidate)
    const relative = path.relative(root, file)
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw fail('Import this reference into the project before generation; the registered file is outside the project folder.')
    const ext = path.extname(file).toLowerCase()
    if (!extensions[assetType].test(ext)) throw fail('The reference filename does not match its media type.')
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    let bytes
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size < 1 || stat.size > limit) throw fail('Reference media must be a regular file between 1 byte and 256 MiB.')
      bytes = Buffer.alloc(stat.size + 1)
      let offset = 0
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null)
        if (!bytesRead) break
        offset += bytesRead
      }
      if (offset !== stat.size) throw fail('The reference file changed while being read. Preview again.')
      bytes = bytes.subarray(0, offset)
    } finally { await handle.close() }
    const fingerprint = createHash('sha256').update(bytes).digest('hex')
    return { bytes, value: `velorn_${fingerprint}${ext}`, fingerprint, size: bytes.length, assetId, assetType }
  }
  async function resolveAsset(input) {
    try { const { bytes, ...plan } = await read(input); return plan }
    catch (error) { throw error.publicMessage ? error : fail('The reference file could not be read. Relink or import it, then preview again.') }
  }
  async function upload(assets, { endpoint, assertCurrent = async () => {} } = {}) {
    const base = localEndpoint(endpoint), uploaded = new Set()
    for (const plan of assets) {
      await assertCurrent()
      let current
      try { current = await read(plan) }
      catch (error) { throw error.publicMessage ? error : fail('The reference file could not be read. Relink or import it, then preview again.') }
      if (current.value !== plan.value || current.fingerprint !== plan.fingerprint) throw fail('The reference file changed since preview. Preview again before generating.')
      await assertCurrent()
      if (uploaded.has(current.value)) continue
      const form = new FormData()
      form.append('image', new Blob([current.bytes]), current.value)
      form.append('type', 'input')
      form.append('overwrite', 'true') // Only our content-addressed input name.
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 60000)
      try {
        const response = await fetchImpl(`${base}/upload/image`, { method: 'POST', body: form, redirect: 'error', signal: controller.signal })
        if (!response.ok) throw fail(`ComfyUI reference upload failed (HTTP ${response.status}). No generation was queued.`)
        const result = await uploadReceipt(response)
        if (result?.name !== current.value || (result.subfolder || '') !== '' || result.type !== 'input') throw fail('ComfyUI returned an unexpected reference filename. No generation was queued.')
      } catch (error) {
        throw error.publicMessage ? error : fail('ComfyUI reference upload did not return a valid receipt. Check the connection and retry; no generation was queued.')
      } finally { clearTimeout(timer) }
      await assertCurrent()
      uploaded.add(current.value)
    }
  }
  // One project picture as the input of a Create request: read the same checked
  // way, but small enough and of a type every Create model takes. The bytes go
  // only to the native Router manager, never back to the caller of a tool.
  async function readPicture({ assetId }) {
    let current
    try { current = await read({ assetId, assetType: 'image' }) }
    catch (error) { throw error.publicMessage ? error : fail('The picture could not be read. Relink or import it, then preview again.') }
    const mimeType = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[path.extname(current.value).toLowerCase()]
    if (!mimeType) throw fail('The input picture must be a PNG, JPEG or WebP file.')
    if (current.size > 10 * 1024 * 1024) throw fail('The input picture is larger than 10 MB. Use a smaller copy.')
    return { mimeType, base64: current.bytes.toString('base64') }
  }
  return { resolveAsset, upload, readPicture }
}
module.exports = { createWorkflowAssetInputs }
