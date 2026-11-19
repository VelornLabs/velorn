'use strict'
const fs = require('node:fs/promises')
const path = require('node:path')
const { randomBytes } = require('node:crypto')
const MIME = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' }
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value)
const originOf = job => job.origin && [job.origin.chatId, job.origin.turnId].every(validId) ? job.origin : null
const finishedTime = job => Number.isFinite(Date.parse(job.finishedAt)) ? Date.parse(job.finishedAt) : 0
const containedBy = (root, file) => {
  const relative = path.relative(root, file)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

// A durable relative path is not permission to follow a newly introduced symlink
// outside the project. The project root itself may be a user-selected symlink.
async function verifyRestoredPath(job, projectPath) {
  const filePath = path.resolve(job.outputPath), projectRoot = path.resolve(projectPath)
  const insideProject = containedBy(projectRoot, filePath)
  if (!insideProject && job.externalAuthorized !== true) throw new Error('Unverified external export')
  const anchor = insideProject ? projectRoot : path.parse(filePath).root
  const canonicalAnchor = await fs.realpath(anchor)
  const relative = path.relative(anchor, filePath)
  let directory = anchor
  for (const segment of relative.split(path.sep).slice(0, -1)) {
    directory = path.join(directory, segment)
    const stat = await fs.lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Export parent is unavailable')
  }
  if (await fs.realpath(filePath) !== path.join(canonicalAnchor, relative)) throw new Error('Export path changed')
}

function selectJobs(liveJobs, savedJobs, context, mimeTypes = MIME) {
  const merged = new Map()
  for (const job of savedJobs) {
    if (job?.jobId && job.projectPath === context.projectPath) merged.set(job.jobId, { ...job, restored: true })
  }
  // Merge before filtering status: a live failed/running record must never be
  // presented as completed just because a stale durable record says it is.
  for (const job of liveJobs) {
    if (!job?.jobId || job.projectPath !== context.projectPath) continue
    const saved = merged.get(job.jobId)
    const origin = originOf(job) || (saved?.outputPath === job.outputPath ? originOf(saved) : null)
    merged.set(job.jobId, { ...job, ...(origin ? { origin } : {}), restored: false })
  }
  const jobs = [...merged.values()].filter(job => job.status === 'completed'
    && mimeTypes[path.extname(job.outputPath || job.name || '').toLowerCase()]).sort((a, b) => finishedTime(b) - finishedTime(a))
  const turns = new Set(Array.isArray(context.turnIds) ? context.turnIds.filter(validId).slice(-100) : [])
  const visible = jobs.filter(job => {
    const origin = originOf(job)
    return origin && origin.chatId === context.chatId && turns.has(origin.turnId)
  })
  // Keep the latest project gallery, plus older exports belonging to currently
  // visible replies. Neither a long chat nor a corrupt index can grow unbounded.
  const selected = new Set([...new Set([...jobs.slice(0, 12), ...visible].map(job => job.jobId))].slice(0, 100))
  return jobs.filter(job => selected.has(job.jobId))
}

// Native completed-job allowlist, never a phone/renderer-supplied file path.
function createMobileVideoCatalog({ getContext, getJobs, getSavedJobs = async () => [], mimeTypes = MIME, mediaRoute = 'exports', emptyState = 'no-exports' }) {
  let scope = '', entries = new Map(), pending = Promise.resolve(), state = 'unavailable'
  async function refresh() {
    const context = await getContext()
    if (!context?.projectPath || !context?.contextId) { scope = ''; entries.clear(); state = context?.blocked || 'unavailable'; return [] }
    const nextScope = JSON.stringify([context.contextId, context.projectPath])
    if (scope !== nextScope) { scope = nextScope; entries.clear() }
    const previous = entries, next = new Map(), cards = []
    const jobs = selectJobs(getJobs(), await getSavedJobs(context.projectPath), context, mimeTypes)
    for (const job of jobs) {
      const filePath = job.outputPath, mime = mimeTypes[path.extname(filePath || job.name || '').toLowerCase()]
      const origin = originOf(job)
      const publicDetails = { name: path.basename(filePath || job.name || 'Exported video'), finishedAt: job.finishedAt,
        ...(origin ? { chatId: origin.chatId, turnId: origin.turnId } : {}) }
      const old = [...previous.values()].find(entry => entry.jobId === job.jobId && entry.filePath === filePath)
      try {
        if (job.unavailable === true || typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('Export file unavailable')
        if (job.restored) await verifyRestoredPath(job, context.projectPath)
        const stat = await fs.lstat(filePath)
        if (!stat.isFile() || stat.size < 1 || !Number.isSafeInteger(stat.size)) throw new Error('Export file unavailable')
        if (job.restored && job.externalAuthorized === true && (!job.expectedIdentity || !sameFile(job.expectedIdentity, stat))) throw new Error('Export file identity changed')
        const id = old?.stat && sameFile(old.stat, stat) ? old.id : randomBytes(24).toString('hex')
        const entry = { id, filePath, stat, mime, jobId: job.jobId }
        next.set(id, entry)
        cards.push({ id, ...publicDetails, bytes: stat.size,
          url: `/media/${mediaRoute}/${id}`, downloadUrl: `/media/${mediaRoute}/${id}/download` })
      } catch {
        const id = old?.unavailable ? old.id : randomBytes(24).toString('hex')
        next.set(id, { id, filePath, jobId: job.jobId, unavailable: true })
        cards.push({ id, ...publicDetails, unavailable: true, reason: 'File unavailable' })
      }
    }
    const after = await getContext()
    if (JSON.stringify([after?.contextId, after?.projectPath]) !== nextScope || scope !== nextScope) { entries.clear(); state = after?.blocked || 'project-changing'; return [] }
    entries = next
    state = cards.some(card => !card.unavailable) ? 'ready' : jobs.length ? 'files-unavailable' : emptyState
    return cards
  }
  function list() {
    const result = pending.then(refresh).catch(error => { entries.clear(); state = 'lookup-failed'; throw error })
    pending = result.catch(() => {})
    return result
  }
  async function open(id) {
    await list() // Recheck project, sharing, job status and file identity on every request.
    const entry = entries.get(id)
    if (!entry || entry.unavailable) return null
    let handle
    try { handle = await fs.open(entry.filePath, 'r') } catch { return null }
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || !sameFile(entry.stat, stat)) { await handle.close(); return null }
      return { handle, size: stat.size, mime: entry.mime, name: path.basename(entry.filePath) }
    } catch (error) { await handle.close(); throw error }
  }
  return { list, open, getStatus: () => ({ state, count: entries.size }) }
}

function byteRange(header, size) {
  if (header === undefined) return { start: 0, end: size - 1, partial: false }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header)
  if (!match || (!match[1] && !match[2])) return null
  let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))
  let end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
  if (![start, end].every(Number.isSafeInteger) || (!match[1] && Number(match[2]) <= 0) || start < 0 || start >= size || end < start) return null
  return { start, end, partial: true }
}
module.exports = { createMobileVideoCatalog, byteRange }
