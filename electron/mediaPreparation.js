// Playback caches and proxies share one bounded, owner-aware native queue.
// Originals are read-only; an output becomes visible only after validation.
const { spawn: nodeSpawn } = require('child_process')
const fsPromises = require('fs/promises')
const path = require('path')
const { randomUUID } = require('crypto')
const os = require('os')

const TERMINAL = new Set(['ready', 'failed', 'cancelled'])
const MAX_STDERR = 8192

function proxyHeight(value) {
  const number = Number(value)
  return Math.round(Math.max(180, Math.min(1080, Number.isFinite(number) && number > 0 ? number : 540)) / 2) * 2
}

function buildMediaPreparationArgs({ kind, inputPath, tempOutputPath, targetHeight, fps, encoder, threads = 2 }) {
  const proxy = kind === 'proxy'
  const filters = []
  if (proxy) filters.push(`scale=-2:${proxyHeight(targetHeight)}`)
  if (fps) filters.push(`fps=${fps}`)
  const args = ['-hide_banner', '-nostdin', '-y', '-threads', String(threads), '-i', inputPath,
    '-map', '0:v:0', '-map', '0:a:0?', '-filter_threads', '1']
  if (filters.length) args.push('-vf', filters.join(','))
  args.push('-c:v', encoder)
  if (encoder === 'h264_nvenc') {
    args.push('-preset', 'p2', '-rc', 'vbr', '-cq', proxy ? '28' : '23', '-b:v', '0')
  } else if (encoder === 'h264_videotoolbox') {
    // Never silently run VideoToolbox's software encoder: our CPU fallback
    // uses the known bundled executable and reports the reason to the UI.
    args.push('-q:v', proxy ? '50' : '65', '-allow_sw', '0', '-realtime', '1')
  } else {
    args.push('-preset', proxy ? 'veryfast' : 'fast', '-crf', proxy ? '28' : '23', '-keyint_min', '6')
  }
  args.push('-threads', String(threads), '-g', '6', '-bf', '0', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', '-c:a', 'aac', '-b:a', proxy ? '128k' : '192k',
    '-ar', '48000', '-ac', '2', '-progress', 'pipe:1', '-nostats', tempOutputPath)
  return args
}

function validatePreparedMedia(input, output, { kind, targetHeight, fps }) {
  if (!output?.success || !output.hasVideo) return output?.error || 'Prepared media validation failed: no video stream.'
  if (output.videoCodec && output.videoCodec !== 'h264') return 'Prepared media validation failed: expected H.264 video.'
  if (output.pixelFormat && output.pixelFormat !== 'yuv420p') return 'Prepared media validation failed: expected 8-bit YUV420 video.'
  if (input.hasAudio && output.hasAudio === false) return 'Prepared media validation failed: audio stream is missing.'
  if (fps && Number.isFinite(Number(output.fps)) && Math.abs(Number(output.fps) - fps) > 0.02) {
    return 'Prepared media validation failed: frame rate changed.'
  }
  const expectedDuration = Number(input.duration)
  const actualDuration = Number(output.duration)
  if (expectedDuration > 0 && actualDuration > 0 && actualDuration + Math.max(0.5, 2 / (fps || 24)) < expectedDuration) {
    return 'Prepared media validation failed: output ended early.'
  }
  if (kind === 'proxy' && output.height > 0 && output.height !== proxyHeight(targetHeight)) {
    return 'Prepared media validation failed: incorrect proxy height.'
  }
  if (kind === 'playback' && input.width > 0 && input.height > 0 && output.width > 0 && output.height > 0) {
    // FFmpeg applies display rotation, so portrait phone footage may swap
    // coded width/height without changing its display resolution.
    const unchanged = input.width === output.width && input.height === output.height
    const rotated = input.width === output.height && input.height === output.width
    if (!unchanged && !rotated) return 'Prepared media validation failed: playback resolution changed.'
  }
  return null
}

function createMediaPreparationService({
  ffmpegPath,
  resolveHardwareFfmpeg = async () => ({ path: ffmpegPath }),
  probeHardwareEncoder = async () => ({ ok: false, error: 'Hardware encoder is unavailable.' }),
  probeVideoInfo,
  normalizeFps = (value) => Number(value) > 0 ? Math.round(Math.max(1, Math.min(60, Number(value))) * 1000) / 1000 : null,
  onStatus = () => {},
  platform = process.platform,
  spawn = nodeSpawn,
  fs = fsPromises,
  maxHistory = 100,
  threads = Math.max(1, Math.min(2, Math.floor((os.availableParallelism?.() || os.cpus().length || 2) / 2))),
} = {}) {
  const jobs = new Map()
  const byOutput = new Map()
  const queue = []
  const records = []
  const counters = new Map()
  let active = null
  let drainScheduled = false
  const historyLimit = Math.max(1, Math.min(500, Number(maxHistory) || 100))
  const threadLimit = Math.max(1, Math.min(4, Math.floor(Number(threads) || 2)))
  const normalizePath = (value) => platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)

  function getStatus(ownerId) {
    const matching = records.filter((record) => ownerId === undefined || record.ownerId === ownerId)
    const counts = ownerId === undefined ? [...counters.values()] : [counters.get(ownerId)].filter(Boolean)
    const count = (key) => counts.reduce((sum, entry) => sum + entry[key], 0)
    return {
      activeCount: new Set(matching.filter((record) => record.status === 'encoding').map((record) => record.id)).size,
      queuedCount: new Set(matching.filter((record) => record.status === 'queued').map((record) => record.id)).size,
      total: count('total'), completed: count('completed'), failed: count('failed'), cancelledCount: count('cancelled'),
      jobs: matching.map(({ resolve, promise, ...record }) => ({ ...record })),
    }
  }

  function emit() {
    try { onStatus(getStatus()) } catch { /* A closed UI must not stop preparation. */ }
  }

  function trimHistory() {
    let excess = records.filter((record) => TERMINAL.has(record.status)).length - historyLimit
    for (let index = 0; index < records.length && excess > 0;) {
      if (TERMINAL.has(records[index].status)) { records.splice(index, 1); excess -= 1 } else index += 1
    }
    const retainedOwners = new Set(records.map((record) => record.ownerId))
    for (const ownerId of counters.keys()) if (!retainedOwners.has(ownerId)) counters.delete(ownerId)
  }

  function update(job, patch) {
    Object.assign(job, patch)
    for (const record of job.subscribers.values()) {
      if (!TERMINAL.has(record.status)) Object.assign(record, patch)
    }
    emit()
  }

  function finishRecord(record, result) {
    if (TERMINAL.has(record.status)) return
    record.status = result.cancelled ? 'cancelled' : result.success ? 'ready' : 'failed'
    if (result.success) record.progress = 1
    if (result.error) record.error = result.error
    const count = counters.get(record.ownerId)
    if (count) count[result.cancelled ? 'cancelled' : result.success ? 'completed' : 'failed'] += 1
    record.resolve(result)
  }

  function cancelledResult() { return { success: false, cancelled: true, error: 'Media preparation cancelled.' } }
  function assertNotCancelled(job) { if (job.cancelled) throw Object.assign(new Error('Media preparation cancelled.'), { cancelled: true }) }
  async function removeTemp(file) { try { await fs.unlink(file) } catch { /* Not created, or already removed. */ } }

  function encode(job, binary, args, duration) {
    return new Promise((resolve) => {
      let child
      let stderr = ''
      let progressBuffer = ''
      let outputSeconds = 0
      let settled = false
      const finish = (result) => {
        if (settled) return
        settled = true
        job.process = null
        resolve(result)
      }
      try { child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }) }
      catch (error) { finish({ success: false, error: error?.message || String(error) }); return }
      job.process = child
      child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-MAX_STDERR) })
      child.stdout?.on('data', (chunk) => {
        progressBuffer += chunk.toString()
        const lines = progressBuffer.split(/\r?\n/)
        progressBuffer = lines.pop().slice(-1024)
        for (const line of lines) {
          const [key, value] = line.split('=')
          if (key === 'out_time_us' || key === 'out_time_ms') {
            const seconds = Number(value) / 1000000
            if (Number.isFinite(seconds)) outputSeconds = seconds
          }
          if (key === 'progress' && duration > 0 && !job.cancelled) {
            update(job, { progress: Math.max(job.progress || 0, Math.min(0.99, Math.max(0, outputSeconds / duration))) })
          }
        }
      })
      child.on('error', (error) => finish({ success: false, error: error?.message || String(error) }))
      child.on('close', (code) => finish(code === 0 ? { success: true } : {
        success: false, error: stderr.trim() || `FFmpeg exited with code ${code}.`,
      }))
      if (job.cancelled) { try { child.kill('SIGKILL') } catch { /* Already exited. */ } }
    })
  }

  async function attempt(job, input, fps, encoder, binary) {
    const tempOutputPath = path.join(path.dirname(job.outputPath), `.${path.basename(job.outputPath)}.${randomUUID()}.tmp.mp4`)
    let validated = false
    try {
      assertNotCancelled(job)
      update(job, { encoder, hardware: encoder !== 'libx264', progress: input.duration > 0 ? 0 : null })
      const args = buildMediaPreparationArgs({ ...job, tempOutputPath, fps, encoder, threads: threadLimit })
      const encoded = await encode(job, binary, args, input.duration)
      assertNotCancelled(job)
      if (!encoded.success) return encoded
      const output = await probeVideoInfo(tempOutputPath)
      assertNotCancelled(job)
      const error = validatePreparedMedia(input, output, { ...job, fps })
      if (error) return { success: false, error }
      validated = true
      return { success: true, tempOutputPath, fps: output.fps || fps || null }
    } finally {
      if (!validated) await removeTemp(tempOutputPath)
    }
  }

  async function run(job) {
    let prepared
    try {
      assertNotCancelled(job)
      if (!ffmpegPath) throw new Error('FFmpeg binary not available.')
      const input = await probeVideoInfo(job.inputPath)
      assertNotCancelled(job)
      if (!input?.success || !input.hasVideo) throw new Error(input?.error || 'Source contains no video stream.')
      if (input.hasAlpha) throw new Error('Media with transparency must use the original preview source.')
      const fps = normalizeFps(input.fps)
      await fs.mkdir(path.dirname(job.outputPath), { recursive: true })
      assertNotCancelled(job)
      // Resolve the parent even when the output does not exist yet: an alias
      // of the source's parent must not redirect publication onto the source.
      if (typeof fs.realpath === 'function') {
        const original = await fs.realpath(job.inputPath)
        const outputParent = await fs.realpath(path.dirname(job.outputPath))
        assertNotCancelled(job)
        if (normalizePath(original) === normalizePath(path.join(outputParent, path.basename(job.outputPath)))) {
          throw new Error('Preparation must not overwrite the original media through a directory alias.')
        }
      }
      // Path spelling alone cannot identify the same file on case-insensitive
      // volumes (including common macOS setups). Compare native identities,
      // keeping case-sensitive volumes valid and conservatively refusing
      // source hard-link/symlink aliases too. BigInts avoid inode truncation.
      const originalStat = await fs.stat(job.inputPath, { bigint: true })
      let outputStat
      try {
        outputStat = await fs.stat(job.outputPath, { bigint: true })
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      assertNotCancelled(job)
      if (outputStat && originalStat.dev === outputStat.dev && originalStat.ino === outputStat.ino) {
        throw new Error('Preparation must not overwrite the original media through a file alias.')
      }
      const hardwareEncoder = platform === 'darwin' ? 'h264_videotoolbox'
        : platform === 'win32' || platform === 'linux' ? 'h264_nvenc' : null
      let selection
      let fallbackReason = null
      try {
        selection = hardwareEncoder ? await resolveHardwareFfmpeg() : null
        assertNotCancelled(job)
        const capability = selection?.path ? await probeHardwareEncoder(hardwareEncoder, selection.path) : null
        assertNotCancelled(job)
        if (!capability?.ok) fallbackReason = [selection?.warning, capability?.error || 'Hardware encoding is unavailable.'].filter(Boolean).join(' ')
      } catch (error) {
        if (error.cancelled) throw error
        fallbackReason = error?.message || 'Hardware encoding is unavailable.'
      }
      if (!fallbackReason) {
        try {
          prepared = await attempt(job, input, fps, hardwareEncoder, selection.path)
          if (!prepared.success) fallbackReason = prepared.error || 'Hardware encoding failed.'
        } catch (error) {
          if (job.cancelled || error.cancelled) throw error
          fallbackReason = error?.message || 'Hardware encoding failed.'
        }
      }
      if (fallbackReason) {
        assertNotCancelled(job)
        update(job, { fallbackReason: fallbackReason.slice(-MAX_STDERR) })
        prepared = await attempt(job, input, fps, 'libx264', ffmpegPath)
      }
      assertNotCancelled(job)
      if (!prepared.success) return { ...prepared, encoder: job.encoder, hardware: job.hardware, fallbackReason: job.fallbackReason }
      await fs.rename(prepared.tempOutputPath, job.outputPath)
      return { success: true, fps: prepared.fps, encoder: job.encoder, hardware: job.hardware, fallbackReason: job.fallbackReason }
    } catch (error) {
      return job.cancelled || error.cancelled ? cancelledResult() : {
        success: false, error: error?.message || String(error), encoder: job.encoder, hardware: job.hardware, fallbackReason: job.fallbackReason,
      }
    } finally {
      if (prepared?.tempOutputPath) await removeTemp(prepared.tempOutputPath)
    }
  }

  function scheduleDrain() {
    if (drainScheduled) return
    drainScheduled = true
    queueMicrotask(async () => {
      drainScheduled = false
      if (active) return
      const job = queue.shift()
      if (!job) return
      active = job
      update(job, { status: 'encoding' })
      const result = await run(job)
      for (const record of job.subscribers.values()) finishRecord(record, job.cancelled ? cancelledResult() : result)
      jobs.delete(job.id)
      if (byOutput.get(job.key) === job) byOutput.delete(job.key)
      active = null
      trimHistory()
      emit()
      scheduleDrain()
    })
  }

  function enqueue(options = {}) {
    const { inputPath, outputPath, kind, ownerId = 'default', assetId = null, label } = options
    if (!['playback', 'proxy'].includes(kind)) return Promise.resolve({ success: false, error: 'Invalid media preparation kind.' })
    if (typeof inputPath !== 'string' || !inputPath || typeof outputPath !== 'string' || !outputPath) {
      return Promise.resolve({ success: false, error: 'Missing inputPath or outputPath.' })
    }
    if (!path.isAbsolute(inputPath) || !path.isAbsolute(outputPath)) {
      return Promise.resolve({ success: false, error: 'Media preparation requires absolute input and output paths.' })
    }
    const key = normalizePath(outputPath)
    if (normalizePath(inputPath) === key) return Promise.resolve({ success: false, error: 'Preparation must not overwrite the original media.' })
    let job = byOutput.get(key)
    if (job && (job.inputPath !== inputPath || job.kind !== kind || (kind === 'proxy' && proxyHeight(job.targetHeight) !== proxyHeight(options.targetHeight)))) {
      return Promise.resolve({ success: false, error: 'A different preparation job already owns this output path.' })
    }
    if (job?.cancelled) return Promise.resolve({ success: false, cancelled: true, error: 'Previous preparation for this output is still cancelling.' })
    const existing = job?.subscribers.get(ownerId)
    if (existing && !TERMINAL.has(existing.status)) return existing.promise
    const ownerBusy = records.some((record) => record.ownerId === ownerId && !TERMINAL.has(record.status))
    if (!ownerBusy) {
      for (let index = records.length - 1; index >= 0; index -= 1) if (records[index].ownerId === ownerId) records.splice(index, 1)
      counters.set(ownerId, { total: 0, completed: 0, failed: 0, cancelled: 0 })
    }
    if (!job) {
      job = { id: randomUUID(), key, kind, inputPath, outputPath, targetHeight: options.targetHeight,
        status: 'queued', progress: null, encoder: null, hardware: false, fallbackReason: null,
        subscribers: new Map(), process: null, cancelled: false }
      jobs.set(job.id, job)
      byOutput.set(key, job)
      queue.push(job)
    }
    let resolve
    const promise = new Promise((done) => { resolve = done })
    const record = { id: job.id, ownerId, assetId, kind, label: String(label || path.basename(inputPath)).slice(0, 240),
      status: job.status, progress: job.progress, encoder: job.encoder, hardware: job.hardware, fallbackReason: job.fallbackReason,
      resolve, promise }
    records.push(record)
    job.subscribers.set(ownerId, record)
    counters.get(ownerId).total += 1
    emit()
    scheduleDrain()
    return promise
  }

  function cancelOwner(ownerId) {
    let cancelledCount = 0
    for (const job of jobs.values()) {
      const record = job.subscribers.get(ownerId)
      if (!record || TERMINAL.has(record.status)) continue
      cancelledCount += 1
      const otherSubscriber = [...job.subscribers.values()].some((entry) => entry !== record && !TERMINAL.has(entry.status))
      // A sole active request settles only after its process and temporary
      // output are gone. Shared subscribers may detach immediately.
      if (otherSubscriber || job !== active) finishRecord(record, cancelledResult())
      if (otherSubscriber) continue
      job.cancelled = true
      if (job === active) {
        try { job.process?.kill('SIGKILL') } catch { /* Process is already gone. */ }
      } else {
        const index = queue.indexOf(job)
        if (index !== -1) queue.splice(index, 1)
        jobs.delete(job.id)
        byOutput.delete(job.key)
      }
    }
    trimHistory()
    emit()
    return { success: true, cancelledCount }
  }

  function cancelAll() {
    let cancelledCount = 0
    for (const ownerId of counters.keys()) cancelledCount += cancelOwner(ownerId).cancelledCount
    return { success: true, cancelledCount }
  }

  return { enqueue, getStatus, cancelOwner, cancelAll }
}

module.exports = { createMediaPreparationService, buildMediaPreparationArgs, validatePreparedMedia, proxyHeight }
