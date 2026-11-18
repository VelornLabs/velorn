'use strict'

// Durable review receipts, not project edits. Image bytes live beside this
// manifest; export files are referenced without copying them. Never treat a
// project-supplied absolute path as permission to read outside the project.
const fs = require('node:fs/promises')
const { constants } = require('node:fs')
const path = require('node:path')
const { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } = require('node:crypto')

const MAX_FRAME_BYTES = 300_000
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024
const MAX_FRAMES = 2000, MAX_EXPORTS = 2000, MAX_RETURNED_FRAMES = 100
const ID = /^[A-Za-z0-9_-]{1,110}$/
const FILE = /^[a-f0-9]{64}\.(jpg|png|webp)$/
const queues = new Map()
const fail = (message, code = 'INVALID') => Object.assign(new Error(message), { code: `ERR_AGENT_REVIEW_${code}` })
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
const safeId = value => typeof value === 'string' && ID.test(value)
const validTime = value => typeof value === 'string' && value.length < 40 && Number.isFinite(Date.parse(value))
const plain = value => value && typeof value === 'object' && !Array.isArray(value)

function absolute(value) {
  if (typeof value !== 'string' || value.includes('\0') || !path.isAbsolute(value)) throw fail('Review project/path must be an absolute native path.')
  return path.resolve(value)
}
function relative(value) {
  return typeof value === 'string' && value.length <= 4096 && !/[\\\0:]/.test(value)
    && !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..')
}
async function noSymlinks(filePath) {
  if (!samePath(await fs.realpath(filePath), path.resolve(filePath))) throw fail('Review media paths cannot contain symbolic links.', 'UNSAFE_PATH')
  return fs.lstat(filePath)
}
async function directory(dir, create = false) {
  if (create) {
    try { await fs.mkdir(dir, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
  }
  const stat = await noSymlinks(dir)
  if (!stat.isDirectory()) throw fail('Review storage path is not a directory.', 'UNSAFE_PATH')
}
async function readBounded(filePath, limit) {
  await noSymlinks(filePath)
  const handle = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > limit) throw fail('Review file exceeds its storage limit or is not a regular file.', 'LIMIT')
    // Do not let a concurrently growing file defeat the allocation bound.
    const bytes = Buffer.alloc(stat.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null)
      if (!bytesRead) break
      offset += bytesRead
    }
    if (offset !== stat.size) throw fail('Review file changed while it was being read.', 'CHANGED')
    return bytes.subarray(0, offset)
  } finally { await handle.close() }
}
async function atomicWrite(filePath, bytes) {
  await directory(path.dirname(filePath))
  try {
    const stat = await fs.lstat(filePath)
    if (!stat.isFile() || stat.isSymbolicLink()) throw fail('Review destination is not a regular file.', 'UNSAFE_PATH')
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  const temporary = path.join(path.dirname(filePath), `.pending-${randomUUID()}`)
  let handle
  try {
    handle = await fs.open(temporary, 'wx', 0o600)
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close(); handle = null
    await directory(path.dirname(filePath))
    await fs.rename(temporary, filePath)
  } finally {
    if (handle) await handle.close().catch(() => {})
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
}
function enqueue(projectPath, operation) {
  const root = absolute(projectPath)
  const previous = queues.get(root) || Promise.resolve()
  const result = previous.catch(() => {}).then(() => operation(root))
  const tail = result.catch(() => {})
  queues.set(root, tail)
  tail.finally(() => { if (queues.get(root) === tail) queues.delete(root) })
  return result
}
function dimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 4096 || height > 4096) throw fail('Review image dimensions are invalid or too large.')
}
function raster(bytes, mime) {
  if (!bytes.length || bytes.length > MAX_FRAME_BYTES) throw fail('Review image exceeds the thumbnail storage limit.', 'LIMIT')
  if (mime === 'image/png') {
    if (bytes.length < 45 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
      || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR'
      || bytes.toString('ascii', bytes.length - 8, bytes.length - 4) !== 'IEND') throw fail('Invalid PNG review image.')
    dimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20)); return 'png'
  }
  if (mime === 'image/jpeg') {
    if (bytes.length < 12 || bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) throw fail('Invalid JPEG review image.')
    let offset = 2, found = false
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) break
      while (bytes[offset] === 0xff) offset++
      const marker = bytes[offset++]
      if (marker === 0xda || marker === 0xd9) break
      if (marker >= 0xd0 && marker <= 0xd8 || marker === 0x01) continue
      if (offset + 2 > bytes.length) break
      const length = bytes.readUInt16BE(offset)
      if (length < 2 || offset + length > bytes.length) break
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 8) break
        dimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)); found = true
      }
      offset += length
    }
    if (!found) throw fail('JPEG review image has no valid dimensions.')
    return 'jpg'
  }
  if (mime === 'image/webp') {
    if (bytes.length < 30 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP'
      || bytes.readUInt32LE(4) + 8 !== bytes.length || !['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16))) throw fail('Invalid WebP review image.')
    const kind = bytes.toString('ascii', 12, 16)
    if (bytes.readUInt32LE(16) > bytes.length - 20) throw fail('Invalid WebP review image chunk.')
    if (kind === 'VP8X') dimensions(bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1)
    else if (kind === 'VP8L') {
      if (bytes[20] !== 0x2f) throw fail('Invalid lossless WebP review image.')
      dimensions(1 + (bytes[21] | (bytes[22] & 0x3f) << 8), 1 + (bytes[22] >> 6 | bytes[23] << 2 | (bytes[24] & 0xf) << 10))
    } else {
      if (bytes.toString('hex', 23, 26) !== '9d012a') throw fail('Invalid WebP review frame.')
      dimensions(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff)
    }
    return 'webp'
  }
  throw fail('Only PNG, JPEG and WebP review thumbnails can be stored.')
}
function imageData(dataUrl) {
  if (typeof dataUrl !== 'string' || dataUrl.length > Math.ceil(MAX_FRAME_BYTES / 3) * 4 + 40) throw fail('Review image exceeds the thumbnail storage limit.', 'LIMIT')
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl)
  if (!match || match[2].length % 4) throw fail('Review image must be a base64 raster data URL.')
  const bytes = Buffer.from(match[2], 'base64')
  if (bytes.toString('base64') !== match[2]) throw fail('Review image encoding is invalid.')
  const extension = raster(bytes, match[1])
  return { bytes, mime: match[1], extension }
}
function frameMetadata(frame) {
  if (!plain(frame) || ![frame.id, frame.chatId, frame.turnId].every(safeId)
    || typeof frame.label !== 'string' || frame.label.length > 200
    || !Number.isFinite(frame.capturedAt) || frame.capturedAt < 0
    || frame.timeSeconds !== undefined && (!Number.isFinite(frame.timeSeconds) || frame.timeSeconds < 0)
    || frame.timelineId !== undefined && !safeId(frame.timelineId)) throw fail('Review frame metadata is invalid.')
  return { id: frame.id, chatId: frame.chatId, turnId: frame.turnId, label: frame.label, capturedAt: frame.capturedAt,
    ...(frame.timeSeconds !== undefined ? { timeSeconds: frame.timeSeconds } : {}),
    ...(frame.timelineId !== undefined ? { timelineId: frame.timelineId } : {}) }
}
function origin(value) {
  if (value === undefined || value === null) return undefined
  if (!plain(value) || !safeId(value.chatId) || !safeId(value.turnId)) throw fail('Export conversation ownership is invalid.')
  return { chatId: value.chatId, turnId: value.turnId }
}
function identity(stat) { return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs } }
const sameIdentity = (a, b) => ['dev', 'ino', 'size', 'mtimeMs'].every(key => a[key] === b[key])
const validIdentity = value => plain(value) && ['dev', 'ino', 'size', 'mtimeMs'].every(key => Number.isFinite(value[key]) && value[key] >= 0)

function validateManifest(value) {
  if (!plain(value) || value.version !== 1 || !safeId(value.projectId) || !Array.isArray(value.frames) || !Array.isArray(value.exports)
    || value.frames.length > MAX_FRAMES || value.exports.length > MAX_EXPORTS) throw fail('Review manifest is invalid; it has not been overwritten.', 'MANIFEST')
  const seen = new Set()
  for (const frame of value.frames) {
    frameMetadata(frame)
    if (seen.has(frame.id) || !plain(frame.media) || !FILE.test(frame.media.file) || !['image/png', 'image/jpeg', 'image/webp'].includes(frame.media.mime)
      || !/^[a-f0-9]{64}$/.test(frame.media.sha256) || frame.media.file.split('.')[0] !== frame.media.sha256
      || !Number.isInteger(frame.media.bytes) || frame.media.bytes < 1 || frame.media.bytes > MAX_FRAME_BYTES) throw fail('Review manifest contains invalid image records.', 'MANIFEST')
    seen.add(frame.id)
  }
  seen.clear()
  for (const job of value.exports) {
    if (!plain(job) || !safeId(job.jobId) || seen.has(job.jobId) || !validTime(job.finishedAt)
      || job.startedAt !== null && !validTime(job.startedAt) || !['ui', 'mcp'].includes(job.owner)
      || !plain(job.reference) || !['project', 'external'].includes(job.reference.kind)
      || job.reference.kind === 'project' && !relative(job.reference.path)
      || job.reference.kind === 'external' && (typeof job.reference.path !== 'string' || job.reference.path.length > 4096 || job.reference.path.includes('\0')
        || !validIdentity(job.reference.identity) || typeof job.reference.signature !== 'string' || job.reference.signature.length > 64)) throw fail('Review manifest contains invalid export records.', 'MANIFEST')
    origin(job.origin)
    if (job.batchId !== undefined && job.batchId !== null && !safeId(job.batchId)) throw fail('Invalid export batch ID.', 'MANIFEST')
    seen.add(job.jobId)
  }
  if (value.audioOrigins !== undefined) {
    if (!Array.isArray(value.audioOrigins) || value.audioOrigins.length > 4000) throw fail('Invalid audio review history.', 'MANIFEST')
    const audioKeys = new Set()
    for (const record of value.audioOrigins) {
      if (!plain(record) || !['asset','prompt'].includes(record.kind) || !safeId(record.id) || !record.origin) throw fail('Invalid audio review reference.', 'MANIFEST')
      origin(record.origin)
      const key = `${record.kind}:${record.id}`
      if (audioKeys.has(key)) throw fail('Duplicate audio review reference.', 'MANIFEST')
      audioKeys.add(key)
    }
  }
  if (value.playable !== undefined) {
    if (!Array.isArray(value.playable) || value.playable.length > 2000) throw fail('Invalid playable review history.', 'MANIFEST')
    const ids = new Set()
    for (const item of value.playable) {
      if (!plain(item) || !safeId(item.id) || ids.has(item.id) || !safeId(item.assetId)
        || !['audio', 'video'].includes(item.type) || !relative(item.path)
        || typeof item.name !== 'string' || item.name.length > 300 || !item.origin) throw fail('Invalid playable review record.', 'MANIFEST')
      origin(item.origin); ids.add(item.id)
    }
  }
  return value
}

function createAgentReviewMediaStore({ externalKeyPath } = {}) {
  let keyPromise
  const instanceKey = randomBytes(32)
  async function signingKey(create = false) {
    if (!externalKeyPath) return instanceKey
    if (keyPromise) return keyPromise
    const keyPath = absolute(externalKeyPath)
    const load = async () => {
      await directory(path.dirname(keyPath))
      try {
        const key = await readBounded(keyPath, 32)
        if (key.length !== 32) throw fail('Review authorization key is invalid.', 'KEY')
        return key
      } catch (error) {
        if (error.code !== 'ENOENT' || !create) throw error
        const key = randomBytes(32)
        try { await fs.writeFile(keyPath, key, { flag: 'wx', mode: 0o600 }); return key } catch (writeError) {
          if (writeError.code !== 'EEXIST') throw writeError
          const existing = await readBounded(keyPath, 32)
          if (existing.length !== 32) throw fail('Review authorization key is invalid.', 'KEY')
          return existing
        }
      }
    }
    const pending = load()
    keyPromise = pending
    pending.catch(() => { if (keyPromise === pending) keyPromise = undefined })
    return pending
  }
  const signaturePayload = (manifest, job) => JSON.stringify({ projectId: manifest.projectId, jobId: job.jobId,
    origin: job.origin || null, path: job.reference.path, identity: job.reference.identity })
  async function layout(root, create = false) {
    await directory(root)
    const base = path.join(root, '.velorn'), dir = path.join(base, 'agent-review')
    await directory(base, create); await directory(dir, create)
    return { dir, manifestPath: path.join(dir, 'manifest.json'), framesDir: path.join(dir, 'frames') }
  }
  async function load(root, create = false) {
    let locations
    try { locations = await layout(root, false) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      if (!create) return { manifest: null }
      locations = await layout(root, true)
    }
    try {
      const bytes = await readBounded(locations.manifestPath, MAX_MANIFEST_BYTES)
      let value
      try { value = JSON.parse(bytes.toString('utf8')) } catch { throw fail('Review manifest is unreadable; it has not been overwritten.', 'MANIFEST') }
      return { ...locations, manifest: validateManifest(value) }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return { ...locations, manifest: create ? { version: 1, projectId: randomUUID(), frames: [], exports: [] } : null }
    }
  }
  async function persist(state) {
    validateManifest(state.manifest)
    const bytes = Buffer.from(JSON.stringify(state.manifest))
    if (bytes.length > MAX_MANIFEST_BYTES) throw fail('Review history reached its metadata storage limit. Existing history was retained.', 'LIMIT')
    await atomicWrite(state.manifestPath, bytes)
  }
  async function restoredFrame(state, frame, includeData) {
    const result = frameMetadata(frame)
    try {
      const filePath = path.join(state.framesDir, frame.media.file)
      if (!includeData) {
        const stat = await noSymlinks(filePath)
        if (!stat.isFile() || stat.size !== frame.media.bytes) throw fail('Review image is damaged.', 'CORRUPT')
        return result
      }
      const bytes = await readBounded(filePath, MAX_FRAME_BYTES)
      if (bytes.length !== frame.media.bytes || digest(bytes) !== frame.media.sha256) throw fail('Review image is damaged.', 'CORRUPT')
      raster(bytes, frame.media.mime)
      return { ...result, dataUrl: `data:${frame.media.mime};base64,${bytes.toString('base64')}` }
    } catch (error) {
      return { ...result, unavailable: true, reason: error.code === 'ENOENT' ? 'file-missing' : 'file-unavailable' }
    }
  }
  function saveFrame(projectPath, frame) {
    return enqueue(projectPath, async root => {
      const metadata = frameMetadata(frame), image = imageData(frame.dataUrl), state = await load(root, true)
      const previous = state.manifest.frames.find(item => item.id === metadata.id)
      if (previous && (previous.chatId !== metadata.chatId || previous.turnId !== metadata.turnId)) throw fail('An existing review image cannot be moved to another conversation.')
      if (!previous && state.manifest.frames.length >= MAX_FRAMES) throw fail('Review history reached its image limit. Existing history was retained.', 'LIMIT')
      const sha256 = digest(image.bytes), file = `${sha256}.${image.extension}`
      const record = { ...metadata, media: { file, mime: image.mime, sha256, bytes: image.bytes.length } }
      if (previous) state.manifest.frames[state.manifest.frames.indexOf(previous)] = record
      else state.manifest.frames.push(record)
      // Check manifest bounds before writing a new image, leaving old receipts
      // untouched on rejection. A crash can leave an unreferenced image only.
      if (Buffer.byteLength(JSON.stringify(state.manifest)) > MAX_MANIFEST_BYTES) throw fail('Review history reached its metadata limit.', 'LIMIT')
      await directory(state.framesDir, true)
      await atomicWrite(path.join(state.framesDir, file), image.bytes)
      await persist(state)
      return metadata
    })
  }
  function listFrames(projectPath, { chatId, turnIds, includeData = true } = {}) {
    return enqueue(projectPath, async root => {
      if (!safeId(chatId) || turnIds !== undefined && (!Array.isArray(turnIds) || turnIds.length > 100 || !turnIds.every(safeId))) throw fail('Review conversation filter is invalid.')
      const state = await load(root)
      if (!state.manifest) return []
      const turns = turnIds === undefined ? null : new Set(turnIds)
      const frames = state.manifest.frames.filter(frame => frame.chatId === chatId && (!turns || turns.has(frame.turnId))).slice(-MAX_RETURNED_FRAMES)
      return Promise.all(frames.map(frame => restoredFrame(state, frame, includeData !== false)))
    })
  }
  function readFrame(projectPath, id) {
    return enqueue(projectPath, async root => {
      if (!safeId(id)) throw fail('Review image ID is invalid.')
      const state = await load(root), frame = state.manifest?.frames.find(item => item.id === id)
      return frame ? restoredFrame(state, frame, true) : null
    })
  }
  function saveExport(job) {
    return enqueue(job?.projectPath, async root => {
      if (!plain(job) || job.status !== 'completed' || !safeId(job.jobId) || !validTime(job.finishedAt)
        || job.startedAt != null && !validTime(job.startedAt) || job.batchId != null && !safeId(job.batchId)) throw fail('Only completed native export jobs can be remembered.')
      const outputPath = absolute(job.outputPath)
      if (!['.mp4', '.mov', '.webm'].includes(path.extname(outputPath).toLowerCase())) throw fail('Only completed video exports can be remembered.')
      const stat = await noSymlinks(outputPath)
      if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 1) throw fail('Completed export file is unavailable.')
      const state = await load(root, true), previous = state.manifest.exports.find(item => item.jobId === job.jobId), owned = origin(job.origin)
      if (!previous && state.manifest.exports.length >= MAX_EXPORTS) throw fail('Review history reached its export limit. Existing history was retained.', 'LIMIT')
      if (previous?.origin && JSON.stringify(previous.origin) !== JSON.stringify(owned)) throw fail('A saved export cannot be moved to another conversation.')
      const localPath = path.relative(root, outputPath).split(path.sep).join('/')
      const reference = relative(localPath) ? { kind: 'project', path: localPath } : { kind: 'external', path: outputPath, identity: identity(stat) }
      const record = { jobId: job.jobId, owner: job.owner === 'mcp' ? 'mcp' : 'ui', startedAt: job.startedAt || null, finishedAt: job.finishedAt,
        ...(job.batchId ? { batchId: job.batchId } : {}), ...(owned ? { origin: owned } : {}), reference }
      if (reference.kind === 'external') reference.signature = createHmac('sha256', await signingKey(true)).update(signaturePayload(state.manifest, record)).digest('hex')
      if (previous) state.manifest.exports[state.manifest.exports.indexOf(previous)] = record
      else state.manifest.exports.push(record)
      await persist(state)
      return { jobId: job.jobId, saved: true }
    })
  }
  function listExports(projectPath) {
    return enqueue(projectPath, async root => {
      const state = await load(root)
      if (!state.manifest) return []
      return Promise.all([...state.manifest.exports].reverse().map(async record => {
        const { reference, ...metadata } = record
        const result = { ...metadata, status: 'completed', projectPath: root, persisted: true,
          name: reference.kind === 'project' ? path.posix.basename(reference.path) : path.basename(reference.path) }
        let outputPath
        try {
          if (reference.kind === 'external') {
            if (!path.isAbsolute(reference.path)) throw fail('External export belongs to another platform.')
            const expected = createHmac('sha256', await signingKey()).update(signaturePayload(state.manifest, record)).digest()
            const signature = Buffer.from(reference.signature, 'hex')
            if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) throw fail('External export reference is not authorized.')
            outputPath = absolute(reference.path)
          } else outputPath = path.join(root, ...reference.path.split('/'))
          const stat = await noSymlinks(outputPath)
          if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 1) throw fail('Export file is unavailable.')
          if (reference.kind === 'external' && !sameIdentity(reference.identity, identity(stat))) throw fail('External export file has changed.')
          return { ...result, outputPath, ...(reference.kind === 'external' ? { externalAuthorized: true, expectedIdentity: reference.identity } : {}) }
        } catch (error) {
          return { ...result, ...(reference.kind === 'project' && outputPath ? { outputPath } : {}), unavailable: true,
            reason: error.code === 'ENOENT' ? 'file-missing' : 'file-unavailable' }
        }
      }))
    })
  }
  function bindAudio(projectPath, references, owner) {
    return enqueue(projectPath, async root => {
      const owned = origin(owner)
      if (!owned || !Array.isArray(references) || references.length > 512
        || references.some(ref => !plain(ref) || !['asset','prompt'].includes(ref.kind) || !safeId(ref.id))) throw fail('Invalid audio review binding.')
      if (!references.length) return
      const state = await load(root, true), records = state.manifest.audioOrigins || []
      const keys = new Set(records.map(ref => `${ref.kind}:${ref.id}`))
      let changed = false
      for (const ref of references) {
        const key = `${ref.kind}:${ref.id}`
        if (keys.has(key)) continue // Later status checks cannot move an existing attachment.
        if (records.length >= 4000) throw fail('Audio review history is full.', 'LIMIT')
        records.push({ kind: ref.kind, id: ref.id, origin: owned }); keys.add(key); changed = true
      }
      if (changed) { state.manifest.audioOrigins = records; await persist(state) }
    })
  }
  function listAudioOrigins(projectPath) {
    return enqueue(projectPath, async root => (await load(root)).manifest?.audioOrigins || [])
  }
  function savePlayable(projectPath, assets, owner) {
    return enqueue(projectPath, async root => {
      const owned = origin(owner)
      if (!owned || !Array.isArray(assets) || assets.length > 100) throw fail('Invalid media attachment.')
      const state = await load(root, true), records = state.manifest.playable || []
      let changed = false
      for (const asset of assets) {
        if (!safeId(asset?.id) || !['audio', 'video'].includes(asset.type) || !relative(asset.path)) throw fail('Invalid project media attachment.')
        if (records.some(item => item.assetId === asset.id && item.origin.chatId === owned.chatId && item.origin.turnId === owned.turnId)) continue
        if (records.length >= 2000) throw fail('Media review history is full.')
        records.push({ id: `media-${randomUUID()}`, assetId: asset.id, type: asset.type, path: asset.path,
          name: String(asset.name || path.posix.basename(asset.path)).slice(0, 300), origin: owned })
        changed = true
      }
      if (changed) { state.manifest.playable = records; await persist(state) }
    })
  }
  function listPlayable(projectPath) {
    return enqueue(projectPath, async root => {
      const state = await load(root)
      return Promise.all((state.manifest?.playable || []).map(async item => {
        const outputPath = path.join(root, ...item.path.split('/'))
        try {
          const stat = await noSymlinks(outputPath)
          if (!stat.isFile() || stat.size < 1) throw fail('Media file unavailable.')
          return { ...item, outputPath }
        } catch { return { ...item, outputPath, unavailable: true } }
      }))
    })
  }
  return { saveFrame, listFrames, readFrame, saveExport, listExports, bindAudio, listAudioOrigins,
    savePlayable, listPlayable,
    hasPending:()=>queues.size>0, flush:()=>Promise.all([...queues.values()]) }
}

module.exports = { createAgentReviewMediaStore, MAX_FRAME_BYTES, MAX_RETURNED_FRAMES }
