'use strict'
// What this computer keeps of the jobs other people sent to it through the
// Velorn network, so its owner can look at a job before reporting it: one small
// folder per job with the picture that came in, the clip that was made and a
// note of who sent it and what they wrote. Only the last few jobs are kept, and
// none longer than thirty days. Jobs from the person's own computers are never
// kept here. Nothing in this folder is sent anywhere, with one exception: when the owner
// reports a job, that job's result (and the picture that came in) go to Velorn's reviewers.
const fs = require('node:fs/promises')
const path = require('node:path')

const JOB_ID = /^[A-Za-z0-9_-]{8,64}$/
const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
  // A music workflow's result, kept like a clip so View and Report have the song.
  'audio/mpeg': 'mp3', 'audio/flac': 'flac', 'audio/ogg': 'opus' }
const OUTCOMES = new Set(['done', 'declined', 'stopped', 'failed'])
const text = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max)

function createGpuShareJobLog({ dir, keep = 10, keepMs = 30 * 86400000, now = Date.now } = {}) {
  if (!path.isAbsolute(dir || '')) throw new TypeError('The job log needs a folder.')
  let tail = Promise.resolve()
  const queue = action => { const result = tail.then(action); tail = result.catch(() => {}); return result }
  const folderOf = jobId => path.join(dir, jobId)

  async function readAll() {
    let names = []
    try { names = await fs.readdir(dir) } catch { return [] }
    const items = []
    for (const name of names.filter(item => JOB_ID.test(item))) {
      try {
        const note = JSON.parse(await fs.readFile(path.join(dir, name, 'job.json'), 'utf8'))
        if (note?.jobId !== name || !Number.isFinite(note.at) || !OUTCOMES.has(note.outcome)) continue
        items.push({ jobId: name, from: text(note.from, 260), prompt: text(note.prompt, 300), outcome: note.outcome, at: note.at, reported: note.reported === true, hasFiles: note.hasFiles === true })
      } catch { /* A folder without a readable note is not listed; prune() removes it. */ }
    }
    return items.sort((a, b) => b.at - a.at)
  }
  // Removes everything but the newest few, anything too old, and folders that are not a job's.
  async function prune() {
    const kept = new Set((await readAll()).filter(item => now() - item.at < keepMs).slice(0, keep).map(item => item.jobId))
    let names = []
    try { names = await fs.readdir(dir) } catch { return }
    for (const name of names) if (!kept.has(name)) await fs.rm(path.join(dir, name), { recursive: true, force: true }).catch(() => {})
  }

  return {
    // Newest first: { jobId, from, prompt, outcome, at, reported, hasFiles }.
    list: () => queue(async () => { await prune(); return readAll() }),
    // `image` and `clip` are { mimeType, bytes } or null (a declined job has neither).
    save: ({ jobId, from, prompt, outcome, image = null, clip = null } = {}) => queue(async () => {
      if (!JOB_ID.test(jobId || '') || !OUTCOMES.has(outcome)) return
      const folder = folderOf(jobId)
      await fs.mkdir(folder, { recursive: true, mode: 0o700 })
      let files = 0
      for (const [label, file] of [['picture', image], ['clip', clip]]) {
        const extension = file && EXTENSIONS[file.mimeType]
        if (!extension || !(file.bytes instanceof Uint8Array) || !file.bytes.byteLength) continue
        await fs.writeFile(path.join(folder, `${label}.${extension}`), file.bytes, { mode: 0o600 }); files++
      }
      await fs.writeFile(path.join(folder, 'job.json'), `${JSON.stringify({ jobId, from: text(from, 260), prompt: text(prompt, 300), outcome, at: now(), reported: false, hasFiles: files > 0 })}\n`, { mode: 0o600 })
      await prune()
    }),
    markReported: jobId => queue(async () => {
      if (!JOB_ID.test(jobId || '')) return
      const file = path.join(folderOf(jobId), 'job.json')
      try { const note = JSON.parse(await fs.readFile(file, 'utf8')); await fs.writeFile(file, `${JSON.stringify({ ...note, reported: true })}\n`, { mode: 0o600 }) } catch { /* Already gone. */ }
    }),
    // The files kept of one job, for sending along with a report: { image, clip }, each { mimeType, bytes } or null.
    files: jobId => queue(async () => {
      const out = { image: null, clip: null }
      if (!JOB_ID.test(jobId || '')) return out
      let names = []
      try { names = await fs.readdir(folderOf(jobId)) } catch { return out }
      for (const [label, key] of [['picture', 'image'], ['clip', 'clip']]) {
        const name = names.find(item => item.startsWith(`${label}.`))
        const mimeType = name && Object.keys(EXTENSIONS).find(type => EXTENSIONS[type] === name.slice(label.length + 1))
        if (mimeType) { try { out[key] = { mimeType, bytes: await fs.readFile(path.join(folderOf(jobId), name)) } } catch { /* Gone meanwhile. */ } }
      }
      return out
    }),
    // The folder to show the person, or null when that job kept no files.
    folder: jobId => queue(async () => {
      if (!JOB_ID.test(jobId || '')) return null
      const found = (await readAll()).find(item => item.jobId === jobId)
      return found?.hasFiles ? folderOf(jobId) : null
    }),
  }
}

module.exports = { createGpuShareJobLog }
