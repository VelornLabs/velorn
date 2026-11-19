'use strict'

// Only called for a completed, typed Codex imageGeneration event. Never parse
// paths/images out of assistant prose or execute a second generation on failure.
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { randomUUID } = require('node:crypto')
const MAX_IMAGE_BYTES = 12 * 1024 * 1024
function imageExtension(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png'
  if (bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217) return 'jpg'
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'webp'
  throw Error('Codex returned an unsupported or incomplete image.')
}
function toolBody(result) {
  if (result?.isError) throw Error('Velorn could not import the generated image. Inspect the recorded import result before retrying.')
  for (const block of result?.content || []) {
    if (block.type !== 'text') continue
    let body
    try { body = JSON.parse(block.text) } catch { continue }
    if (body.success === false || body.result?.success === false) throw Error('Velorn could not import the generated image. Inspect the recorded import result before retrying.')
    if (body.result?.asset) return body.result
    if (body.asset) return body
  }
  throw Error('The generated-image import returned no asset confirmation. Do not automatically repeat it.')
}
async function receiveGeneratedImage(item, { toolSession, onReview = () => {}, signal, isCurrent = () => true,
  nativeImage = require('electron').nativeImage, fsImpl = fs } = {}) {
  const check = () => { if (signal?.aborted || !isCurrent()) throw Error('The image request was stopped or its project changed. No further import was attempted.') }
  check()
  let bytes
  if (typeof item.result === 'string' && item.result.length) {
    const encoded = item.result.replace(/^data:image\/(?:png|jpeg|webp);base64,/, '')
    if (encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || encoded.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw Error('Codex returned invalid or oversized image data.')
    bytes = Buffer.from(encoded, 'base64')
    if (bytes.toString('base64') !== encoded) throw Error('Codex returned invalid image data.')
  } else if (typeof item.savedPath === 'string' && path.isAbsolute(item.savedPath)) {
    // savedPath is supplied by the native protocol, not by a model message.
    const stat = await fsImpl.lstat(item.savedPath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_IMAGE_BYTES) throw Error('Codex generated-image file is unavailable or too large.')
    bytes = await fsImpl.readFile(item.savedPath)
  } else throw Error('Codex finished image generation without an image or saved file.')
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw Error('Codex returned an empty or oversized image.')
  const extension = imageExtension(bytes)
  const decoded = nativeImage.createFromBuffer(bytes)
  if (decoded.isEmpty()) throw Error('The generated image could not be decoded.')
  check()
  // Keep a recovery original if import fails; never delete Codex-owned files.
  const directory = await fsImpl.mkdtemp(path.join(os.tmpdir(), 'velorn-generated-image-'))
  const source = path.join(directory, `gpt-image-${randomUUID()}.${extension}`)
  await fsImpl.writeFile(source, bytes, { flag: 'wx', mode: 0o600 })
  let imported
  try {
    check()
    if (!toolSession) throw Error('Enable Velorn tools and open a saved project to import this image.')
    imported = toolBody(await toolSession.callTool('import_asset_from_path', {
      path: source, category: 'images', asSequence: false, folderPath: 'Generated Images/GPT Image', previewOnly: false,
    }))
    if (imported.previewOnly || !imported.asset?.id) throw Error('Generated-image import was not confirmed.')
    check()
    const { width, height } = decoded.getSize()
    let thumbnail
    for (const size of [960, 640, 320]) {
      const scale = Math.min(1, size / width, size / height)
      thumbnail = decoded.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }).toJPEG(75)
      if (thumbnail.length <= 750000) break
    }
    if (!thumbnail?.length || thumbnail.length > 750000) throw Error('The image was imported, but its chat preview could not be prepared.')
    onReview({ id: `review-${randomUUID()}`, label: 'Generated image · GPT Image',
      dataUrl: `data:image/jpeg;base64,${thumbnail.toString('base64')}`, capturedAt: Date.now() })
    // Cleanup failure is not an import failure (e.g. a Windows file scanner
    // holding the temporary original). Do not invite a duplicate import.
    await fsImpl.unlink(source).catch(() => {})
    await fsImpl.rmdir(directory).catch(() => {})
    return { assetId: imported.asset.id, name: imported.asset.name, saved: imported.savedProject === true }
  } catch (error) {
    // Import could already have succeeded. Preserve the recovery file and never
    // turn a later display/save error into an automatic second import.
    throw Error(`${error.message} ${imported?.asset?.id ? `Imported asset: ${imported.asset.id}. ` : ''}Recovery image: ${source}`)
  }
}
module.exports = { receiveGeneratedImage, imageExtension, toolBody, MAX_IMAGE_BYTES }
