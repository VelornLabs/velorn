// Song listening engine: "drop a song, get timed lyrics" for the music video.
//
// The work itself runs in songMapWorker.cjs as a separate process, so a long
// song cannot freeze or bring down the app. This file checks that the pieces
// are on the computer, starts the worker, and passes progress to the window.
//
// Pieces it needs:
//   - whisper-cli and a speech model, shared with captions (captionWhisper.js)
//   - a vocal separator and an aligner, kept in <userData>/song-engine/models
// `install()` downloads whatever is missing: the speech engine and model
// through the captions installer, the two song models through
// songEngineModels.cjs.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { createSongEngineModels, FILES: SONG_MODEL_DOWNLOADS } = require('./songEngineModels.cjs')

const ENGINE_DIR_NAME = 'song-engine'
const SONG_MODEL_FILES = {
  separator: 'Kim_Vocal_2.onnx',
  aligner: 'aligner.onnx',
  alignerDict: 'aligner_dict.json',
}
// Best first. The large model hears sung words most reliably; the smaller
// ones are close and much faster, so any installed caption model will do.
const SPEECH_MODEL_PREFERENCE = ['large-v3-turbo', 'small', 'base', 'tiny']
const SONG_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.mp4', '.mov', '.mkv', '.webm'])
const JOB_TIMEOUT_MS = 45 * 60 * 1000
// The speech model listening works best with, and its size for the download button.
const SPEECH_MODEL_TO_INSTALL = 'large-v3-turbo'
const SPEECH_MODEL_BYTES = 1620 * 1024 * 1024

const failure = (code, error) => ({ success: false, code, error })

function createSongMapEngine({
  app,
  ffmpegPath,
  captionService,
  workerPath = path.join(__dirname, 'songMapWorker.cjs'),
  spawnProcess = spawn,
  execPath = process.execPath,
  fetchImpl = globalThis.fetch,
} = {}) {
  let active = null
  let installing = null
  // Set when the graphics-card version of the speech program found no card or failed: it is not tried again until Velorn restarts.
  let cardGaveUp = false

  const modelsDir = () => path.join(app.getPath('userData'), ENGINE_DIR_NAME, 'models')

  function resolvePieces() {
    const dir = modelsDir()
    const missing = []
    const songModel = (key) => {
      const filePath = path.join(dir, SONG_MODEL_FILES[key])
      if (!fs.existsSync(filePath)) missing.push(key === 'alignerDict' ? 'aligner' : key)
      return filePath
    }
    const pieces = {
      separatorModelPath: songModel('separator'),
      alignerModelPath: songModel('aligner'),
      alignerDictPath: songModel('alignerDict'),
      ffmpegPath,
      whisperCliPath: null,
      whisperGpuCliPath: null,
      whisperModelPath: null,
      speechModelId: null,
    }
    if (!ffmpegPath || !fs.existsSync(ffmpegPath)) missing.push('ffmpeg')
    let speech = null
    try { speech = captionService?.getStatus?.() } catch { speech = null }
    if (speech?.binaryPath && fs.existsSync(speech.binaryPath)) pieces.whisperCliPath = speech.binaryPath
    else missing.push('speech engine')
    // The graphics-card version, when there is one and it has not already let us down since Velorn started.
    if (!cardGaveUp && speech?.gpuBinaryPath && fs.existsSync(speech.gpuBinaryPath)) pieces.whisperGpuCliPath = speech.gpuBinaryPath
    const installed = Array.isArray(speech?.models) ? speech.models : []
    const model = SPEECH_MODEL_PREFERENCE.map((id) => installed.find((entry) => entry.id === id && entry.path)).find(Boolean) || installed.find((entry) => entry.path)
    if (model) { pieces.whisperModelPath = model.path; pieces.speechModelId = model.id } else missing.push('speech model')
    return { pieces, missing: [...new Set(missing)] }
  }

  // How much there is to download to make listening work here.
  function downloadBytes(missing) {
    const dir = modelsDir()
    const songModels = SONG_MODEL_DOWNLOADS.reduce((sum, item) => {
      let have = false
      try { have = fs.statSync(path.join(dir, item.name)).size === item.bytes } catch { have = false }
      return sum + (have ? 0 : item.bytes)
    }, 0)
    return songModels + (missing.includes('speech model') ? SPEECH_MODEL_BYTES : 0)
  }

  function status() {
    const { pieces, missing } = resolvePieces()
    // ffmpeg ships with Velorn; if it is missing a download cannot fix it.
    const canInstall = missing.length > 0 && !missing.includes('ffmpeg') && typeof captionService?.install === 'function'
    return { success: true, ready: missing.length === 0, missing, speechModelId: pieces.speechModelId, modelsDir: modelsDir(), busy: Boolean(active),
      installing: Boolean(installing), canInstall, downloadBytes: missing.length ? downloadBytes(missing) : 0 }
  }

  // Downloads everything listening needs. `notify` receives { step, doneBytes, totalBytes }.
  function install(notify = () => {}) {
    if (!installing) installing = (async () => {
      try {
        let { missing } = resolvePieces()
        if (missing.includes('ffmpeg')) return failure('SONG_MAP_INSTALL_FAILED', 'Velorn is missing a built-in part it needs for listening. Reinstall Velorn.')
        if (missing.includes('speech engine') || missing.includes('speech model')) {
          if (typeof captionService?.install !== 'function') return failure('SONG_MAP_INSTALL_FAILED', 'The speech model cannot be downloaded on this computer.')
          notify({ step: 'speech', doneBytes: 0, totalBytes: 0 })
          // The captions installer reports its own byte counts; pass them on so
          // the 1.6 GB speech model shows a moving bar instead of only a spinner.
          const stopProgress = typeof captionService.onProgress === 'function'
            ? captionService.onProgress((update) => {
              const totalBytes = Number(update?.totalBytes) || 0
              if (totalBytes > 0) notify({ step: 'speech', doneBytes: Math.min(totalBytes, Number(update?.receivedBytes) || 0), totalBytes })
            })
            : null
          let speech
          try { speech = await captionService.install({ modelId: SPEECH_MODEL_TO_INSTALL }) }
          finally { if (typeof stopProgress === 'function') stopProgress() }
          if (!speech?.success) return failure('SONG_MAP_INSTALL_FAILED', speech?.error || 'The speech model did not download.')
        }
        const songModels = createSongEngineModels({ dir: modelsDir(), fetchImpl, notify: progress => notify({ step: 'song', ...progress }) })
        const result = await songModels.install()
        if (!result.success) return failure('SONG_MAP_INSTALL_FAILED', result.error)
        ;({ missing } = resolvePieces())
        if (missing.length) return failure('SONG_MAP_INSTALL_FAILED', 'The download finished but listening is still not ready. Try again.')
        return { success: true, ...status() }
      } catch (error) {
        return failure('SONG_MAP_INSTALL_FAILED', error?.message || 'The download did not finish.')
      } finally { installing = null }
    })()
    return installing
  }

  function analyze(options = {}, sender) {
    if (active) return Promise.resolve(failure('SONG_MAP_BUSY', 'Velorn is already listening to a song. Wait for it to finish.'))
    const inputPath = typeof options.inputPath === 'string' ? options.inputPath : ''
    if (!inputPath || !path.isAbsolute(inputPath) || !SONG_EXTENSIONS.has(path.extname(inputPath).toLowerCase())) {
      return Promise.resolve(failure('SONG_MAP_INVALID', 'This file is not a song Velorn can listen to.'))
    }
    if (!fs.existsSync(inputPath)) return Promise.resolve(failure('SONG_MAP_NOT_FOUND', 'Velorn could not find this song file.'))
    const { pieces, missing } = resolvePieces()
    if (missing.length) return Promise.resolve({ ...failure('SONG_MAP_NOT_READY', 'Listening is not set up on this computer yet.'), missing })

    const request = {
      inputPath,
      ffmpegPath: pieces.ffmpegPath,
      whisperCliPath: pieces.whisperCliPath,
      ...(pieces.whisperGpuCliPath ? { whisperGpuCliPath: pieces.whisperGpuCliPath } : {}),
      whisperModelPath: pieces.whisperModelPath,
      separatorModelPath: pieces.separatorModelPath,
      alignerModelPath: pieces.alignerModelPath,
      alignerDictPath: pieces.alignerDictPath,
      threads: Math.max(2, Math.min(8, (os.cpus()?.length || 4) - 2)),
      language: 'en',
      // After the card has let us down once, the worker is told not to try it at all.
      ...(cardGaveUp ? { useCard: false } : {}),
    }

    const attempt = (request) => new Promise((resolve) => {
      const child = spawnProcess(execPath, [workerPath, JSON.stringify(request)], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      const job = { child, done: false, cancelled: false }
      active = job
      let buffer = ''
      let errorTail = ''
      let result = null
      const finish = (value) => {
        if (job.done) return
        job.done = true
        clearTimeout(timer)
        if (active === job) active = null
        resolve(value)
      }
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* already gone */ }
        finish(failure('SONG_MAP_TIMEOUT', 'Listening took too long and was stopped.'))
      }, JOB_TIMEOUT_MS)
      job.cancel = () => {
        job.cancelled = true
        try { child.kill('SIGKILL') } catch { /* already gone */ }
      }
      child.stdout.on('data', (chunk) => {
        buffer += chunk.toString()
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          newline = buffer.indexOf('\n')
          if (!line) continue
          let message = null
          try { message = JSON.parse(line) } catch { continue }
          if (message.type === 'progress') {
            try { if (sender && !sender.isDestroyed?.()) sender.send('songMap:progress', { step: message.step, percent: message.percent }) } catch { /* window closed */ }
          } else if (message.type === 'result' || message.type === 'error') {
            result = message
          }
        }
      })
      child.stderr.on('data', (chunk) => { errorTail = (errorTail + chunk.toString()).slice(-600) })
      child.on('error', (error) => finish(failure('SONG_MAP_FAILED', `Listening could not start: ${error.message}`)))
      child.on('close', () => {
        if (job.cancelled) return finish(failure('SONG_MAP_CANCELLED', 'Listening was stopped.'))
        if (result?.type === 'result') {
          if (result.speech?.cardProblem || Object.values(result.models || {}).some(model => model?.problem)) cardGaveUp = true
          return finish({
            success: true,
            duration: result.duration,
            lines: result.rows,
            voice: result.voice,
            speechModelId: pieces.speechModelId,
            seconds: result.seconds,
            // Where the words were heard: 'card' (graphics card) or 'processor'; and why the card was not used, if it was tried.
            speech: { used: result.speech?.used === 'card' ? 'card' : 'processor', ...(result.speech?.cardProblem ? { cardProblem: result.speech.cardProblem === 'no-card' ? 'no-card' : 'failed' } : {}) },
            // The other two steps: 'card' or 'processor' each.
            models: Object.fromEntries(['voice', 'timing'].map(name => [name, result.models?.[name]?.on === 'card' ? 'card' : 'processor'])),
          })
        }
        // A problem the worker reported itself (a song it cannot read, say) is final. Only a worker that died without a word is tried again.
        finish({ ...failure('SONG_MAP_FAILED', result?.error || `Listening stopped unexpectedly. ${errorTail}`.trim()), ...(result ? {} : { stopped: true }) })
      })
    })
    // A graphics card can also take the whole worker down with it, which the worker cannot catch itself.
    // So a listen that stopped while the card was allowed is tried once more on the processor alone, and
    // the card is left alone until Velorn restarts.
    return attempt(request).then((first) => {
      const { stopped, ...answer } = first
      if (!stopped || request.useCard === false) return answer
      cardGaveUp = true
      const { whisperGpuCliPath, ...plain } = request
      return attempt({ ...plain, useCard: false }).then(({ stopped: again, ...second }) => second)
    })
  }

  function cancel() {
    if (!active) return { success: true, cancelled: false }
    active.cancel()
    return { success: true, cancelled: true }
  }

  return { status, analyze, cancel, install }
}

function registerSongMapHandlers({ ipcMain, app, ffmpegPath, captionService }) {
  const engine = createSongMapEngine({ app, ffmpegPath, captionService })
  ipcMain.handle('songMap:status', () => {
    try { return engine.status() } catch (error) { return failure('SONG_MAP_FAILED', String(error?.message || error)) }
  })
  ipcMain.handle('songMap:analyze', (event, options = {}) => engine.analyze(options, event.sender))
  ipcMain.handle('songMap:cancel', () => engine.cancel())
  ipcMain.handle('songMap:install', (event) => engine.install((progress) => {
    try { if (event.sender && !event.sender.isDestroyed?.()) event.sender.send('songMap:installProgress', progress) } catch { /* window closed */ }
  }))
  app.on('will-quit', () => { engine.cancel() })
  return engine
}

module.exports = { createSongMapEngine, registerSongMapHandlers, SONG_MODEL_FILES, SPEECH_MODEL_PREFERENCE }
