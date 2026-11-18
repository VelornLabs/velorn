'use strict'

// A surviving ComfyUI process must not write to pipes owned by an Electron
// session. Regular append-only files keep inherited descriptors valid after
// that session exits or crashes. Polling these files is only a log viewer; it
// is never required for the child to make progress.
const fs = require('node:fs')
const path = require('node:path')
const { randomBytes } = require('node:crypto')
const { StringDecoder } = require('node:string_decoder')

const DEFAULTS = Object.freeze({ intervalMs: 250, maxBytes: 50 * 1024 * 1024, readBytes: 256 * 1024, carryChars: 4000, linesPerPoll: 2000 })
const STREAMS = ['stdout', 'stderr']
const FILE_NAME = /^comfyui-console-\d+-[a-f0-9]{12}-(stdout|stderr)\.log$/

function validRecord(logDir, record) {
  if (typeof logDir !== 'string' || !logDir || !record || typeof record !== 'object') return null
  const result = {}
  for (const stream of STREAMS) {
    const name = record[stream]
    if (typeof name !== 'string' || !FILE_NAME.test(name) || !name.endsWith(`-${stream}.log`) || path.basename(name) !== name) return null
    result[stream] = name
  }
  if (result.stdout.replace('-stdout.log', '') !== result.stderr.replace('-stderr.log', '')) return null
  return result
}

function createComfyConsoleLog({ logDir, record, onLine = () => {}, onWarning = () => {}, ...settings } = {}) {
  const limits = { ...DEFAULTS, ...settings }
  const warn = message => { try { onWarning(message) } catch { /* Logs cannot stop generation. */ } }
  const emit = (stream, text) => { if (text) try { onLine(stream, text) } catch { /* Viewer only. */ } }
  const entries = []
  let savedRecord = null, timer = null, activePoll = null, stopped = false
  const restoring = record !== undefined

  const closeDescriptors = () => {
    for (const entry of entries) if (Number.isInteger(entry.fd)) {
      try { fs.closeSync(entry.fd) } catch { /* Already closed on spawn failure. */ }
      entry.fd = null
    }
  }
  try {
    if (typeof logDir !== 'string' || !logDir) throw Error('No console log directory is available.')
    if (restoring) {
      savedRecord = validRecord(logDir, record)
      if (!savedRecord) throw Error('The saved console log names are invalid.')
    } else {
      fs.mkdirSync(logDir, { recursive: true })
      const prefix = `comfyui-console-${Date.now()}-${randomBytes(6).toString('hex')}`
      savedRecord = Object.fromEntries(STREAMS.map(stream => [stream, `${prefix}-${stream}.log`]))
    }
    for (const stream of STREAMS) {
      const filename = path.join(logDir, savedRecord[stream])
      // Exclusive creation prevents following an existing symlink. Restored
      // files are checked again on each poll and opened with O_NOFOLLOW where
      // available; the saved record contains basenames, never arbitrary paths.
      const fd = restoring ? null : fs.openSync(filename, 'ax', 0o600)
      entries.push({ stream, filename, fd, position: restoring ? null : 0,
        decoder: new StringDecoder('utf8'), carry: '', skipFirstLine: false, warned: false })
    }
  } catch (error) {
    closeDescriptors(); entries.length = 0; savedRecord = null
    warn(`ComfyUI console capture is unavailable (${error.message}); output will be discarded so it can still survive Velorn closing.`)
  }
  // Copy the numeric descriptors: closing the parent's copies after spawn
  // never closes the independent handles inherited by the child.
  const stdio = ['ignore', ...STREAMS.map(stream => entries.find(entry => entry.stream === stream)?.fd ?? 'ignore')]

  const reset = entry => { entry.decoder = new StringDecoder('utf8'); entry.carry = '' }
  const consume = (entry, buffer) => {
    const lines = (entry.carry + entry.decoder.write(buffer)).split(/\r\n|\r|\n/)
    entry.carry = lines.pop() || ''
    if (entry.skipFirstLine) {
      if (lines.length) { lines.shift(); entry.skipFirstLine = false }
      else entry.carry = ''
    }
    for (const line of lines.slice(-limits.linesPerPoll)) emit(entry.stream, line.slice(0, limits.carryChars))
    if (entry.carry.length > limits.carryChars) entry.carry = entry.carry.slice(0, limits.carryChars)
  }

  const readEntry = async entry => {
    let handle
    try {
      const linkStat = await fs.promises.lstat(entry.filename)
      if (!linkStat.isFile() || linkStat.isSymbolicLink()) throw Error('Console log is not a regular file.')
      handle = await fs.promises.open(entry.filename, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0))
      const stat = await handle.stat()
      if (!stat.isFile() || stat.dev !== linkStat.dev || stat.ino !== linkStat.ino) throw Error('Console log changed while opening it.')
      if (entry.position === null || stat.size < entry.position) {
        reset(entry)
        entry.position = Math.max(0, stat.size - limits.readBytes)
        entry.skipFirstLine = entry.position > 0
      }
      if (stat.size - entry.position > limits.readBytes) {
        entry.position = stat.size - limits.readBytes
        reset(entry); entry.skipFirstLine = true
        warn(`Skipped older ${entry.stream} console output to keep the live log viewer responsive.`)
      }
      const size = Math.min(limits.readBytes, Math.max(0, stat.size - entry.position))
      if (size) {
        const buffer = Buffer.allocUnsafe(size)
        const { bytesRead } = await handle.read(buffer, 0, size, entry.position)
        entry.position += bytesRead
        consume(entry, buffer.subarray(0, bytesRead))
      }
      // Never rename an active console file: inherited descriptors would keep
      // writing its old inode. O_APPEND resumes at the new end after truncation.
      // While Velorn is absent these durable files may grow; cap them on return.
      if (stat.size > limits.maxBytes) {
        if (entry.carry && !entry.skipFirstLine) emit(entry.stream, entry.carry)
        await handle.truncate(0)
        entry.position = 0; reset(entry); entry.skipFirstLine = false
        warn(`Trimmed the ${entry.stream} console log in place; ComfyUI continues using the same file.`)
      }
      entry.warned = false
    } catch (error) {
      if (!entry.warned) warn(`Could not read the ${entry.stream} console log: ${error.message}`)
      entry.warned = true
    } finally { await handle?.close().catch(() => {}) }
  }

  const poll = () => {
    if (activePoll) return activePoll
    activePoll = Promise.all(entries.map(readEntry)).finally(() => { activePoll = null })
    return activePoll
  }
  return {
    stdio,
    record: savedRecord,
    closeDescriptors,
    poll,
    start() {
      if (timer || stopped || !entries.length) return
      void poll()
      timer = setInterval(() => { void poll() }, limits.intervalMs)
      timer.unref?.()
    },
    async stop({ flush = true } = {}) {
      stopped = true
      if (timer) { clearInterval(timer); timer = null }
      if (activePoll) await activePoll
      if (flush && entries.length) await poll()
      for (const entry of entries) {
        if (flush && !entry.skipFirstLine) emit(entry.stream, (entry.carry + entry.decoder.end()).slice(0, limits.carryChars))
        reset(entry)
      }
      closeDescriptors()
    },
  }
}

module.exports = { createComfyConsoleLog, validRecord, DEFAULTS }
