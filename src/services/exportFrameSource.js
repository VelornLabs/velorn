/**
 * WebCodecs-based sequential frame source for export.
 *
 * Why this exists: the export renderer historically sampled video pixels by
 * seeking a hidden <video> element to every frame time. A seek is a
 * random-access operation — the decoder flushes and re-decodes from the
 * previous keyframe — so per-frame seeking pays GOP-decode + event latency
 * for every frame of every layer, and it dominates export wall-clock. An
 * export is inherently sequential, which is exactly what VideoDecoder is
 * fast at: demux once (mp4box), feed encoded chunks in decode order, and
 * receive presentation-ordered frames at decode speed with hardware
 * acceleration.
 *
 * Design constraints honored here:
 *   - A ClipFrameCursor serves MONOTONICALLY non-decreasing time requests
 *     (per clip, forward playback). A small ring of recently-presented
 *     frames absorbs the exporter's frame-blend pattern, which re-requests
 *     the previous source frame (base/next pairs that overlap between
 *     export frames).
 *   - Hardware decoders have a small output-frame pool. Holding too many
 *     unclosed VideoFrames stalls the decoder, so ready-queue + ring are
 *     tightly capped and every evicted frame is close()d.
 *   - The consumer draws through `cursor.canvas` (frames are copied into a
 *     per-cursor canvas). That keeps VideoFrame lifetimes fully internal
 *     and lets us apply container rotation (phone footage) exactly once,
 *     matching what a <video> element would have displayed.
 *   - Failure is never fatal: createClipFrameCursor resolves null for
 *     unsupported media, and seek() throws on runtime errors — callers
 *     fall back to the existing <video>-element path per clip.
 *
 * Kill switch: set localStorage 'comfystudio-export-webcodecs' = '0'.
 */
import { createFile, DataStream, MP4BoxBuffer } from 'mp4box'

const WEBCODECS_EXPORT_FLAG_KEY = 'comfystudio-export-webcodecs'

const MICROS = 1e6
// Recently-presented frames kept alive for backward re-requests (frame
// blending). Ring + ready caps must stay well under the hardware decoder's
// output pool (~10) or the decoder stalls waiting for frames to be closed.
const FRAME_RING_SIZE = 3
const MAX_READY_FRAMES = 4
const MAX_DECODE_QUEUE = 24
const PENDING_CHUNK_HIGH_WATER = 3000
const SEEK_WAIT_TIMEOUT_MS = 5000
const DEMUX_READY_TIMEOUT_MS = 15000
// Decode past the clip's out point so boundary frame blends, end-clamped
// samples, and transition HANDLES (the exporter samples beyond trim bounds
// during between-clip transitions via allowHandles) stay servable without
// feeding the whole tail. Callers extend startTime downward for the same
// reason on the in-point side.
const END_FEED_MARGIN_SEC = 1.5
// Give up on sources whose moov hasn't parsed after this much data
// (non-faststart gigabyte originals would otherwise buffer whole-file).
const MAX_BYTES_BEFORE_READY = 1.5e9

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Aggregate diagnostics across all cursors in an export run, surfaced in the
// export completion payload. serves = frames handed to the exporter;
// instantServes = served without any wait loop; waitMs = wall-clock spent
// waiting for decoder output inside seek().
const frameSourceStats = { inits: 0, initMs: 0, serves: 0, instantServes: 0, waits: 0, waitMs: 0 }

export const resetFrameSourceStats = () => {
  frameSourceStats.inits = 0
  frameSourceStats.initMs = 0
  frameSourceStats.serves = 0
  frameSourceStats.instantServes = 0
  frameSourceStats.waits = 0
  frameSourceStats.waitMs = 0
}

export const getFrameSourceStats = () => ({
  inits: frameSourceStats.inits,
  initMs: Math.round(frameSourceStats.initMs),
  serves: frameSourceStats.serves,
  instantServes: frameSourceStats.instantServes,
  waits: frameSourceStats.waits,
  waitMs: Math.round(frameSourceStats.waitMs),
})

export const isWebCodecsExportEnabled = () => {
  if (typeof VideoDecoder === 'undefined' || typeof EncodedVideoChunk === 'undefined') return false
  if (typeof createFile !== 'function') return false
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem(WEBCODECS_EXPORT_FLAG_KEY) === '0') return false
  } catch {
    // localStorage unavailable — treat as enabled
  }
  return true
}

function extractCodecDescription(mp4boxFile, trackId) {
  try {
    const trak = mp4boxFile.getTrackById(trackId)
    const entries = trak?.mdia?.minf?.stbl?.stsd?.entries || []
    for (const entry of entries) {
      const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C
      if (!box) continue
      const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN)
      box.write(stream)
      // Strip the 8-byte box header (size + fourcc); WebCodecs wants the payload.
      return new Uint8Array(stream.buffer, 8)
    }
  } catch (err) {
    console.warn('[ExportFrameSource] Failed to extract codec description:', err)
  }
  return null
}

/**
 * Quarter-turn rotation from the track matrix (16.16 fixed point). A <video>
 * element applies this automatically; raw decoded frames do not, so the
 * cursor bakes it into its canvas. Non-quarter matrices are ignored, which
 * matches Chromium's element behavior.
 */
function getQuarterTurnRotation(matrix) {
  if (!matrix || matrix.length < 5) return 0
  const a = matrix[0] / 65536
  const b = matrix[1] / 65536
  const c = matrix[3] / 65536
  const d = matrix[4] / 65536
  const near = (value, target) => Math.abs(value - target) < 0.01
  if (near(a, 0) && near(b, 1) && near(c, -1) && near(d, 0)) return 90
  if (near(a, -1) && near(b, 0) && near(c, 0) && near(d, -1)) return 180
  if (near(a, 0) && near(b, -1) && near(c, 1) && near(d, 0)) return 270
  return 0
}

class ClipFrameCursor {
  constructor({ url, startTime = 0, endTime = null, label = '' }) {
    this.url = url
    this.label = label || String(url).slice(-48)
    this.startMicros = Math.max(0, Math.round((Number(startTime) || 0) * MICROS))
    this.endMicros = Number.isFinite(Number(endTime)) && endTime != null
      ? Math.round(Number(endTime) * MICROS) + Math.round(END_FEED_MARGIN_SEC * MICROS)
      : null
    this.dead = false
    this.closed = false
    this.error = null
    this.rotation = 0
    this.width = 0
    this.height = 0
    this.canvas = document.createElement('canvas')
    this._canvasCtx = null
    this._drawnTimestamp = -1
    this._decoder = null
    this._mp4box = null
    this._trackId = null
    this._abortController = null
    this._pendingChunks = []
    this._readyFrames = []
    this._ring = []
    this._started = false
    this._gopChunks = []
    this._pastEnd = false
    this._demuxDone = false
    this._flushed = false
    this._ended = false
    this._lastSampleNumber = 0
    this._waiters = []
    this._warnedBackward = false
    this._servedFrame = null
    this._ctsOffsetMicros = 0
  }

  /**
   * What the exporter should drawImage(). Unrotated sources hand back the
   * served VideoFrame directly (skips a full-res canvas copy per layer per
   * frame); rotated sources go through the rotation-baking canvas. The
   * served frame lives in the ring, so it stays alive until several
   * subsequent serves — safely past the exporter's draws for this frame.
   */
  get drawSource() {
    if (this.rotation) return this.canvas
    return this._servedFrame || this.canvas
  }

  _serveFrame(frame) {
    if (this.rotation) {
      this._drawFrame(frame)
      return
    }
    this._servedFrame = frame
    this.width = frame.displayWidth || frame.codedWidth || this.width
    this.height = frame.displayHeight || frame.codedHeight || this.height
  }

  async init() {
    this._abortController = new AbortController()
    const response = await fetch(this.url, { signal: this._abortController.signal })
    if (!response.ok && response.status !== 0 && response.status !== 200) {
      throw new Error(`Fetch failed with status ${response.status}`)
    }

    // keepMdatData=true is load-bearing: mp4box v2 changed the default to
    // DISCARD sample data as it parses (v0.5 always kept it). Extraction
    // options are registered only after onReady, so without this flag
    // getSample() finds no data, onSamples never fires, and every cursor
    // "ends" with zero frames — silently falling back to the element path.
    this._mp4box = createFile(true)
    let readyResolve = null
    let readyReject = null
    const readyPromise = new Promise((resolve, reject) => {
      readyResolve = resolve
      readyReject = reject
    })
    this._mp4box.onReady = (info) => readyResolve?.(info)
    this._mp4box.onError = (err) => {
      const error = new Error(`Demux error: ${err}`)
      readyReject?.(error)
      this._fail(error)
    }
    this._mp4box.onSamples = (id, user, samples) => this._onSamples(samples)

    this._runReadLoop(response).catch((err) => {
      if (!this.closed) this._fail(err)
      readyReject?.(err)
    })

    let readyTimer = 0
    const info = await Promise.race([
      readyPromise,
      new Promise((_, reject) => {
        readyTimer = setTimeout(() => reject(new Error('Timed out waiting for demux')), DEMUX_READY_TIMEOUT_MS)
      }),
    ]).finally(() => clearTimeout(readyTimer))

    const track = (info?.videoTracks || [])[0]
    if (!track) return false

    this._trackId = track.id
    const trak = this._mp4box.getTrackById(track.id)
    this.rotation = getQuarterTurnRotation(track.matrix || trak?.tkhd?.matrix)

    // Presentation-time normalization: files with B-frames typically carry
    // an edit list whose media_time equals the reorder delay (e.g. ffmpeg
    // output: first sample cts 15000@90k with elst media_time 15000). A
    // <video> element applies this so presentation starts at 0; raw sample
    // cts does not — without subtracting it, every served frame would be
    // shifted by the reorder delay (~4 frames on these sources).
    const elstEntries = trak?.edts?.elst?.entries
    const editEntry = Array.isArray(elstEntries)
      ? elstEntries.find((entry) => Number.isFinite(entry?.media_time) && entry.media_time >= 0)
      : null
    const mediaTimescale = Number(track.timescale) || 1
    this._ctsOffsetMicros = editEntry && editEntry.media_time > 0
      ? Math.round((editEntry.media_time / mediaTimescale) * MICROS)
      : 0

    const codec = String(track.codec || '')
    const description = extractCodecDescription(this._mp4box, track.id)
    // avc1/hvc1-family MP4 tracks carry out-of-band parameter sets; without
    // them the decoder cannot be configured, so bail to the element path.
    if (/^(avc|hvc|hev|dvh)/i.test(codec) && !description) return false

    const codedWidth = track.video?.width || track.track_width || 0
    const codedHeight = track.video?.height || track.track_height || 0
    const config = { codec, codedWidth, codedHeight }
    if (description) config.description = description

    const support = await VideoDecoder.isConfigSupported(config).catch(() => null)
    if (!support?.supported) return false

    // Emit decoded frames as soon as they're ready instead of letting the
    // decoder hold a deep internal reorder/output queue — the exporter
    // consumes strictly sequentially and waits on delivery latency.
    config.optimizeForLatency = true
    this._decoder = new VideoDecoder({
      output: (frame) => this._onFrame(frame),
      error: (err) => this._fail(err),
    })
    this._decoder.configure(config)

    const swap = this.rotation === 90 || this.rotation === 270
    this.width = swap ? codedHeight : codedWidth
    this.height = swap ? codedWidth : codedHeight

    this._mp4box.setExtractionOptions(track.id, null, { nbSamples: 100 })
    this._mp4box.start()
    this._pump()
    return true
  }

  async _runReadLoop(response) {
    let offset = 0
    let sniffed = false
    const append = (arrayBuffer) => {
      const mp4Buffer = MP4BoxBuffer.fromArrayBuffer(arrayBuffer, offset)
      offset += arrayBuffer.byteLength
      this._mp4box.appendBuffer(mp4Buffer)
    }
    const sniff = (bytes) => {
      // Reject non-MP4 containers fast (webm/avi/mkv) instead of waiting for
      // the demux-ready timeout. 'ftyp' sits in the first box for any sane MP4.
      const probe = new Uint8Array(bytes.buffer || bytes, 0, Math.min(64, bytes.byteLength))
      const text = Array.from(probe).map((b) => String.fromCharCode(b)).join('')
      if (!text.includes('ftyp')) throw new Error('Not an MP4/MOV container')
    }

    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader()
      try {
        while (true) {
          if (this.closed || this._pastEnd) break
          while (this._pendingChunks.length > PENDING_CHUNK_HIGH_WATER && !this.closed && !this._pastEnd) {
            await sleep(25)
          }
          if (this.closed || this._pastEnd) break
          const { done, value } = await reader.read()
          if (done) break
          if (!value || value.byteLength === 0) continue
          if (!sniffed) {
            sniff(value)
            sniffed = true
          }
          if (offset > MAX_BYTES_BEFORE_READY && !this._trackId) {
            throw new Error('Source too large before demux ready (non-faststart)')
          }
          const chunk = value.byteOffset === 0 && value.byteLength === value.buffer.byteLength
            ? value.buffer
            : value.slice().buffer
          append(chunk)
        }
      } finally {
        try { reader.cancel() } catch { /* ignore */ }
      }
    } else {
      const buffer = await response.arrayBuffer()
      if (buffer.byteLength > 0) {
        sniff(new Uint8Array(buffer, 0, Math.min(64, buffer.byteLength)))
        append(buffer)
      }
    }

    try { this._mp4box.flush() } catch { /* demuxer already stopped */ }
    this._demuxDone = true
    this._pump()
    this._notifyWaiters()
  }

  _onSamples(samples) {
    if (this.closed || this.dead) return
    for (const sample of samples) {
      this._lastSampleNumber = Math.max(this._lastSampleNumber, sample.number || 0)
      if (this._pastEnd || !sample.data) continue
      const ctsMicros = Math.round((sample.cts / sample.timescale) * MICROS) - this._ctsOffsetMicros
      const durationMicros = Math.max(0, Math.round((sample.duration / sample.timescale) * MICROS))
      if (this._started && this.endMicros != null && ctsMicros > this.endMicros) {
        // Past the clip's needed range: stop decoding (and stop reading).
        this._pastEnd = true
        this._demuxDone = true
        try { this._mp4box.stop() } catch { /* ignore */ }
        try { this._abortController?.abort() } catch { /* ignore */ }
        continue
      }
      let chunk
      try {
        chunk = new EncodedVideoChunk({
          type: sample.is_sync ? 'key' : 'delta',
          timestamp: ctsMicros,
          duration: durationMicros,
          data: sample.data,
        })
      } catch (err) {
        this._fail(err)
        return
      }
      if (!this._started) {
        // Buffer the current GOP; once a sample crosses the clip's in-point
        // we start decoding from that GOP's keyframe (frames decoded before
        // the in-point are dropped in _onFrame).
        if (sample.is_sync) this._gopChunks = []
        this._gopChunks.push(chunk)
        if (ctsMicros + durationMicros > this.startMicros) {
          this._started = true
          this._pendingChunks.push(...this._gopChunks)
          this._gopChunks = []
        }
      } else {
        this._pendingChunks.push(chunk)
      }
    }
    // Sample payloads were copied into EncodedVideoChunks — release the
    // demuxer's buffers so long sources don't accumulate in memory.
    try {
      if (this._trackId != null && this._lastSampleNumber > 0) {
        this._mp4box.releaseUsedSamples(this._trackId, this._lastSampleNumber)
      }
    } catch { /* best effort */ }
    this._pump()
  }

  _onFrame(frame) {
    if (this.closed) {
      try { frame.close() } catch { /* ignore */ }
      return
    }
    const end = frame.timestamp + (frame.duration || 0)
    if (end <= this.startMicros - 1) {
      // Pre-roll from the in-point GOP — decoded only to establish references.
      try { frame.close() } catch { /* ignore */ }
    } else {
      this._readyFrames.push(frame)
    }
    this._notifyWaiters()
    this._pump()
  }

  _pump() {
    if (this.closed || this.dead || !this._decoder || this._decoder.state !== 'configured') return
    while (
      this._pendingChunks.length > 0
      && this._decoder.decodeQueueSize < MAX_DECODE_QUEUE
      && this._readyFrames.length < MAX_READY_FRAMES
    ) {
      const chunk = this._pendingChunks.shift()
      try {
        this._decoder.decode(chunk)
      } catch (err) {
        this._fail(err)
        return
      }
    }
    if (
      this._demuxDone
      && !this._flushed
      && this._pendingChunks.length === 0
      && this._decoder.decodeQueueSize === 0
    ) {
      this._flushed = true
      this._decoder.flush()
        .then(() => {
          this._ended = true
          this._notifyWaiters()
        })
        .catch((err) => {
          if (!this.closed) {
            this._ended = true
            this._fail(err)
          }
        })
    }
  }

  _availableFrames() {
    return this._ring.concat(this._readyFrames)
  }

  _consumeReadyUpTo(frame) {
    while (this._readyFrames.length > 0) {
      const head = this._readyFrames.shift()
      this._ring.push(head)
      if (head === frame) break
    }
    while (this._ring.length > FRAME_RING_SIZE) {
      const evicted = this._ring.shift()
      try { evicted.close() } catch { /* ignore */ }
    }
    this._pump()
  }

  _drawFrame(frame) {
    if (this._drawnTimestamp === frame.timestamp) return
    const frameWidth = frame.displayWidth || frame.codedWidth
    const frameHeight = frame.displayHeight || frame.codedHeight
    const swap = this.rotation === 90 || this.rotation === 270
    const canvasWidth = swap ? frameHeight : frameWidth
    const canvasHeight = swap ? frameWidth : frameHeight
    if (this.canvas.width !== canvasWidth) this.canvas.width = canvasWidth
    if (this.canvas.height !== canvasHeight) this.canvas.height = canvasHeight
    this.width = canvasWidth
    this.height = canvasHeight
    if (!this._canvasCtx) {
      this._canvasCtx = this.canvas.getContext('2d', { alpha: false })
    }
    const ctx = this._canvasCtx
    if (!ctx) throw new Error('Frame canvas context unavailable')
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    if (this.rotation) {
      ctx.translate(canvasWidth / 2, canvasHeight / 2)
      ctx.rotate((this.rotation * Math.PI) / 180)
      ctx.translate(-frameWidth / 2, -frameHeight / 2)
    }
    ctx.drawImage(frame, 0, 0, frameWidth, frameHeight)
    ctx.restore()
    this._drawnTimestamp = frame.timestamp
  }

  _waitForActivity(ms) {
    return new Promise((resolve) => {
      const entry = { resolve: null, timer: 0 }
      entry.resolve = resolve
      entry.timer = setTimeout(() => {
        const index = this._waiters.indexOf(entry)
        if (index >= 0) this._waiters.splice(index, 1)
        resolve()
      }, ms)
      this._waiters.push(entry)
    })
  }

  _notifyWaiters() {
    const waiters = this._waiters.splice(0)
    for (const waiter of waiters) {
      clearTimeout(waiter.timer)
      waiter.resolve()
    }
  }

  /**
   * Decode forward until the frame presented at `seconds` is available, then
   * draw it into `this.canvas`. Throws on decoder failure or timeout — the
   * caller falls back to the <video>-element path.
   */
  async seek(seconds) {
    if (this.dead) throw (this.error || new Error('Frame source unavailable'))
    const target = Math.max(this.startMicros, Math.round((Number(seconds) || 0) * MICROS))
    const deadline = Date.now() + SEEK_WAIT_TIMEOUT_MS
    let waitedLoops = 0
    const recordServe = () => {
      frameSourceStats.serves += 1
      if (waitedLoops === 0) frameSourceStats.instantServes += 1
      else frameSourceStats.waits += 1
    }

    while (true) {
      if (this.dead) throw (this.error || new Error('Frame source unavailable'))

      const frames = this._availableFrames()
      let best = null
      let next = null
      for (const frame of frames) {
        if (frame.timestamp <= target) {
          if (!best || frame.timestamp > best.timestamp) best = frame
        } else if (!next || frame.timestamp < next.timestamp) {
          next = frame
        }
      }

      if (best) {
        const covered = target < best.timestamp + (best.duration || 0)
        const settled = this._ended && this._pendingChunks.length === 0
        if (covered || next || settled) {
          if (this._readyFrames.includes(best)) this._consumeReadyUpTo(best)
          this._serveFrame(best)
          recordServe()
          return
        }
      } else if (next) {
        // Request earlier than anything still alive (beyond the ring).
        // Serve the earliest available frame — best effort, should not
        // happen with the exporter's monotonic access pattern.
        if (!this._warnedBackward) {
          this._warnedBackward = true
          console.warn(`[ExportFrameSource] ${this.label}: backward request beyond frame ring; serving nearest frame`)
        }
        this._serveFrame(next)
        recordServe()
        return
      } else if (this._ended && this._pendingChunks.length === 0) {
        const last = this._ring[this._ring.length - 1]
        if (last) {
          this._serveFrame(last)
          recordServe()
          return
        }
        throw new Error('No frames decoded for clip range')
      }

      // Consume frames that end before the target so decode can advance.
      let progressed = false
      while (this._readyFrames.length > 0) {
        const head = this._readyFrames[0]
        const headEnd = head.timestamp + (head.duration || 0)
        const isLastKnownFrame = this._ended
          && this._pendingChunks.length === 0
          && this._readyFrames.length === 1
        if (headEnd <= target && !isLastKnownFrame) {
          this._consumeReadyUpTo(head)
          progressed = true
        } else {
          break
        }
      }

      this._pump()
      if (!progressed) {
        if (Date.now() > deadline) {
          throw new Error(`Timed out waiting for frame at ${(target / MICROS).toFixed(3)}s`)
        }
        waitedLoops += 1
        const waitStart = performance.now()
        await this._waitForActivity(200)
        frameSourceStats.waitMs += performance.now() - waitStart
      }
    }
  }

  _fail(err) {
    if (this.dead) return
    this.error = err instanceof Error ? err : new Error(String(err))
    this.dead = true
    console.warn(`[ExportFrameSource] ${this.label} failed:`, this.error.message)
    this._notifyWaiters()
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.dead = true
    this._servedFrame = null
    this._notifyWaiters()
    try { this._abortController?.abort() } catch { /* ignore */ }
    for (const frame of this._readyFrames.splice(0)) {
      try { frame.close() } catch { /* ignore */ }
    }
    for (const frame of this._ring.splice(0)) {
      try { frame.close() } catch { /* ignore */ }
    }
    this._pendingChunks.length = 0
    this._gopChunks.length = 0
    try {
      if (this._decoder && this._decoder.state !== 'closed') this._decoder.close()
    } catch { /* ignore */ }
    try { this._mp4box?.stop() } catch { /* ignore */ }
    this._mp4box = null
  }
}

/**
 * Create a sequential frame cursor for one clip, or resolve null when the
 * source can't take this path (non-MP4 container, unsupported codec, missing
 * parameter sets, WebCodecs disabled). Never rejects for "unsupported";
 * genuine runtime errors also resolve null so callers can fall back.
 */
export const createClipFrameCursor = async ({ url, startTime = 0, endTime = null, label = '' }) => {
  if (!url || !isWebCodecsExportEnabled()) return null
  const cursor = new ClipFrameCursor({ url, startTime, endTime, label })
  try {
    const initStart = performance.now()
    const ok = await cursor.init()
    if (!ok || cursor.dead) {
      cursor.close()
      return null
    }
    frameSourceStats.inits += 1
    frameSourceStats.initMs += performance.now() - initStart
    return cursor
  } catch (err) {
    console.warn(`[ExportFrameSource] ${label || url}: falling back to video element (${err?.message || err})`)
    cursor.close()
    return null
  }
}
