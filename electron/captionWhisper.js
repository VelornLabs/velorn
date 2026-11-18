// Local caption transcription engine: whisper.cpp driven from the main process.
//
// This is the no-ComfyUI path for Add Captions. The engine lives under the
// app's userData dir (nothing is bundled into the installer): a pinned
// whisper.cpp CLI build plus one or more ggml models, both downloaded on first
// use. Transcription runs the media through the bundled FFmpeg (16 kHz mono
// WAV — whisper's required input) and then whisper-cli with one-word-per-
// segment output, so both caption scopes get word-level timings. Cue grouping
// happens renderer-side (src/services/captionLocalTranscription.js).

const path = require('path')
const fs = require('fs')
const fsp = require('fs/promises')
const os = require('os')
const https = require('https')
const { spawn } = require('child_process')

const WHISPER_RELEASE_TAG = 'v1.9.1'
const PROGRESS_CHANNEL = 'captions:engineProgress'
const ENGINE_DIR_NAME = 'caption-engine'

// Upstream ships prebuilt CLI archives for Windows and Linux only. The macOS
// build comes from our own CI (.github/workflows/whisper-mac-engine.yml): a
// static universal whisper-cli (arm64 Metal + x86_64 CPU) attached to a
// dedicated prerelease whose tag tracks WHISPER_RELEASE_TAG.
const ENGINE_BINARY_DOWNLOADS = {
  win32: {
    url: `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_RELEASE_TAG}/whisper-bin-x64.zip`,
    archiveName: `whisper-bin-x64-${WHISPER_RELEASE_TAG}.zip`,
    approxBytes: 7982101,
  },
  linux: {
    url: `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_RELEASE_TAG}/whisper-bin-ubuntu-x64.tar.gz`,
    archiveName: `whisper-bin-ubuntu-x64-${WHISPER_RELEASE_TAG}.tar.gz`,
    approxBytes: 9379235,
  },
  darwin: {
    url: `https://github.com/VelornLabs/velorn/releases/download/whisper-cli-${WHISPER_RELEASE_TAG}-mac/whisper-cli-macos-universal-${WHISPER_RELEASE_TAG}.zip`,
    archiveName: `whisper-cli-macos-universal-${WHISPER_RELEASE_TAG}.zip`,
    approxBytes: 2451938,
  },
}

// ggml models from the official whisper.cpp Hugging Face mirror. approxMB is
// display-only; downloads trust Content-Length.
const WHISPER_MODELS = {
  tiny: { file: 'ggml-tiny.bin', approxMB: 75, label: 'Tiny — fastest, rough' },
  base: { file: 'ggml-base.bin', approxMB: 142, label: 'Base — fast, good' },
  small: { file: 'ggml-small.bin', approxMB: 466, label: 'Small — slower, better' },
  'large-v3-turbo': { file: 'ggml-large-v3-turbo.bin', approxMB: 1620, label: 'Large v3 Turbo — best, heavy' },
}
const DEFAULT_MODEL_ID = 'base'
const MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/'

// Silero VAD model: keeps whisper from smearing boundary-word timestamps
// across leading/trailing music or silence (captions used to start at frame
// one of an edit whose dialog begins seconds in). Downloaded best-effort;
// deleting the file reverts to VAD-free transcription.
const VAD_MODEL_FILE = 'ggml-silero-v5.1.2.bin'
const VAD_MODEL_URL = `https://huggingface.co/ggml-org/whisper-vad/resolve/main/${VAD_MODEL_FILE}`

const BINARY_CANDIDATE_NAMES = process.platform === 'win32'
  ? ['whisper-cli.exe', 'main.exe']
  : ['whisper-cli', 'main']

const TRANSCRIBE_TIMEOUT_MS = 20 * 60 * 1000
const FFMPEG_TIMEOUT_MS = 10 * 60 * 1000

function engineRoot(app) {
  return path.join(app.getPath('userData'), ENGINE_DIR_NAME)
}

function engineBinDir(app) {
  return path.join(engineRoot(app), 'bin')
}

// A second, optional speech program that uses the graphics card (whisper.cpp built with Vulkan). It lives beside
// the plain one and is only ever tried first; the plain one stays the fall-back. See songMapWorker.cjs.
function engineGpuBinDir(app) {
  return path.join(engineRoot(app), 'bin-gpu')
}

function engineModelsDir(app) {
  return path.join(engineRoot(app), 'models')
}

// The release archives sometimes nest binaries in a subfolder (Release/,
// build/bin/…) — walk a couple of levels rather than assuming a layout.
function findBinaryIn(dir, depth = 3) {
  if (depth < 0) return null
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const name of BINARY_CANDIDATE_NAMES) {
    const hit = entries.find((entry) => entry.isFile() && entry.name.toLowerCase() === name.toLowerCase())
    if (hit) return path.join(dir, hit.name)
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const found = findBinaryIn(path.join(dir, entry.name), depth - 1)
    if (found) return found
  }
  return null
}

function vadModelPath(app) {
  return path.join(engineModelsDir(app), VAD_MODEL_FILE)
}

// Fetch the VAD model if it is not on disk yet. Best-effort: offline or a
// failed download just means transcription proceeds without VAD, exactly as
// it did before the model existed.
async function ensureVadModel(app, sendProgress) {
  const dest = vadModelPath(app)
  if (fs.existsSync(dest)) return dest
  try {
    await ensureDir(engineModelsDir(app))
    if (typeof sendProgress === 'function') {
      sendProgress({ phase: 'download-vad', message: 'Downloading speech detector…', percent: null })
    }
    await downloadFile(VAD_MODEL_URL, dest, {})
    return fs.existsSync(dest) ? dest : null
  } catch (err) {
    console.warn('[captions] Could not download the VAD model (continuing without it):', err?.message || err)
    return null
  }
}

function listInstalledModels(app) {
  const dir = engineModelsDir(app)
  const models = []
  for (const [id, spec] of Object.entries(WHISPER_MODELS)) {
    const modelPath = path.join(dir, spec.file)
    try {
      const stat = fs.statSync(modelPath)
      if (stat.isFile() && stat.size > 1024 * 1024) {
        models.push({ id, file: spec.file, path: modelPath, sizeBytes: stat.size, label: spec.label })
      }
    } catch { /* not installed */ }
  }
  return models
}

function buildEngineStatus(app) {
  const binaryPath = findBinaryIn(engineBinDir(app))
  // A hand-installed binary counts as platform support even when we have no
  // download for this platform — power users can drop a whisper-cli build
  // into the engine dir and the app honors it.
  const platformSupported = Boolean(ENGINE_BINARY_DOWNLOADS[process.platform]) || Boolean(binaryPath)
  const models = listInstalledModels(app)
  return {
    success: true,
    platform: process.platform,
    platformSupported,
    releaseTag: WHISPER_RELEASE_TAG,
    binaryPath: binaryPath || null,
    gpuBinaryPath: findBinaryIn(engineGpuBinDir(app)) || null,
    vadModelInstalled: fs.existsSync(vadModelPath(app)),
    modelsDir: engineModelsDir(app),
    models,
    availableModels: Object.entries(WHISPER_MODELS).map(([id, spec]) => ({
      id,
      file: spec.file,
      approxMB: spec.approxMB,
      label: spec.label,
      installed: models.some((m) => m.id === id),
    })),
    defaultModelId: DEFAULT_MODEL_ID,
    available: Boolean(binaryPath && models.length > 0),
  }
}

// Minimal https downloader with redirect follow (GitHub and Hugging Face both
// bounce to CDNs). Writes to <dest>.partial and renames on success so an
// interrupted download never masquerades as an installed file.
function downloadFile(url, destPath, { onProgress, redirectsLeft = 6 } = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': 'Velorn' } }, (response) => {
      const status = response.statusCode || 0
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume()
        if (redirectsLeft <= 0) {
          reject(new Error('Too many redirects while downloading ' + url))
          return
        }
        const nextUrl = new URL(response.headers.location, url).toString()
        downloadFile(nextUrl, destPath, { onProgress, redirectsLeft: redirectsLeft - 1 }).then(resolve, reject)
        return
      }
      if (status !== 200) {
        response.resume()
        reject(new Error(`Download failed (HTTP ${status}) for ${url}`))
        return
      }

      const totalBytes = Math.max(0, Number(response.headers['content-length']) || 0)
      let receivedBytes = 0
      let lastReport = 0
      const partialPath = `${destPath}.partial`
      const out = fs.createWriteStream(partialPath)

      response.on('data', (chunk) => {
        receivedBytes += chunk.length
        const now = Date.now()
        if (typeof onProgress === 'function' && now - lastReport > 250) {
          lastReport = now
          onProgress({ receivedBytes, totalBytes })
        }
      })
      response.on('error', (err) => {
        out.destroy()
        fsp.unlink(partialPath).catch(() => {})
        reject(err)
      })
      out.on('error', (err) => {
        response.resume()
        fsp.unlink(partialPath).catch(() => {})
        reject(err)
      })
      out.on('finish', () => {
        fsp.rename(partialPath, destPath).then(() => {
          if (typeof onProgress === 'function') onProgress({ receivedBytes, totalBytes: totalBytes || receivedBytes })
          resolve({ receivedBytes })
        }, reject)
      })
      response.pipe(out)
    })
    request.on('error', reject)
  })
}

// bsdtar ships with Windows 10+ and handles .zip as well as .tar.gz, which
// keeps extraction dependency-free across platforms. It must be fed paths
// relative to a cwd: absolute Windows paths ("C:\…") read as rsync-style
// host:path and tar tries to connect to a machine called "C".
function extractArchive(archivePath, destDir) {
  const cwd = path.dirname(archivePath)
  const relArchive = path.basename(archivePath)
  const relDest = path.relative(cwd, destDir) || '.'
  // Pin the System32 bsdtar on Windows: a PATH `tar` may be MSYS/Git GNU tar,
  // which cannot read zip archives.
  const tarBinary = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar'
  return new Promise((resolve, reject) => {
    const proc = spawn(tarBinary, ['-xf', relArchive, '-C', relDest], { windowsHide: true, cwd })
    let stderr = ''
    proc.stderr.on('data', (chunk) => { stderr += chunk })
    proc.on('error', (err) => {
      reject(new Error(`Could not run tar to extract the caption engine: ${err.message}`))
    })
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Extracting ${path.basename(archivePath)} failed (tar exit ${code}): ${stderr.slice(0, 400)}`))
    })
  })
}

function runProcess(binary, args, { timeoutMs, onStderrLine, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(binary, args, { windowsHide: true, cwd })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = timeoutMs
      ? setTimeout(() => {
          settled = true
          try { proc.kill('SIGKILL') } catch { /* ignore */ }
          reject(new Error(`${path.basename(binary)} timed out after ${Math.round(timeoutMs / 1000)}s`))
        }, timeoutMs)
      : null

    let stderrTail = ''
    proc.stdout.on('data', (chunk) => { stdout += chunk })
    proc.stderr.on('data', (chunk) => {
      const text = String(chunk)
      stderr += text
      if (stderr.length > 16384) stderr = stderr.slice(-16384)
      if (typeof onStderrLine === 'function') {
        stderrTail += text
        let idx
        while ((idx = stderrTail.indexOf('\n')) >= 0) {
          onStderrLine(stderrTail.slice(0, idx))
          stderrTail = stderrTail.slice(idx + 1)
        }
      }
    })
    proc.on('error', (err) => {
      if (timer) clearTimeout(timer)
      if (!settled) reject(err)
    })
    proc.on('close', (code) => {
      if (timer) clearTimeout(timer)
      if (settled) return
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${path.basename(binary)} exited with code ${code}: ${stderr.slice(-800)}`))
    })
  })
}

function assertBinaryUsable(binaryPath, label) {
  if (!binaryPath) {
    throw new Error(`${label} is not available.`)
  }
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`${label} is missing at ${binaryPath}.`)
  }
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true })
}

function tempFilePath(suffix) {
  const dir = path.join(os.tmpdir(), 'velorn-captions')
  const name = `caption-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${suffix}`
  return { dir, filePath: path.join(dir, name) }
}

// Normalize any input (video, compressed audio, odd-rate WAV) to whisper's
// required 16 kHz mono s16 WAV via the bundled FFmpeg.
async function normalizeToWav(ffmpegPath, inputPath) {
  assertBinaryUsable(ffmpegPath, 'FFmpeg binary')
  const { dir, filePath } = tempFilePath('.wav')
  await ensureDir(dir)
  const args = [
    '-y',
    '-i', inputPath,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'pcm_s16le',
    filePath,
  ]
  await runProcess(ffmpegPath, args, { timeoutMs: FFMPEG_TIMEOUT_MS })
  return filePath
}

// whisper-cli's JSON output (-oj): { result: { language }, transcription:
// [{ offsets: { from, to } (ms), text }] }. With -ml 1 each entry is
// approximately one word.
function parseWhisperJson(raw) {
  let data = null
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error('Could not parse whisper output JSON.')
  }
  const words = []
  for (const entry of Array.isArray(data?.transcription) ? data.transcription : []) {
    const rawText = String(entry?.text || '')
    const text = rawText.trim()
    if (!text) continue
    if (/^\[.*\]$/.test(text) || /^\(.*\)$/.test(text)) continue // [BLANK_AUDIO], (music) etc.
    const from = Number(entry?.offsets?.from)
    const to = Number(entry?.offsets?.to)
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue
    const end = to > from ? to / 1000 : from / 1000 + 0.08
    // -ml 1 emits tokens, not words. Whisper marks word starts with a leading
    // space; a token without one continues the previous word ("Vel" + "orn"),
    // and detached punctuation tokens ("," ".") glue onto the word they follow.
    if (!/^\s/.test(rawText) && words.length > 0) {
      const prev = words[words.length - 1]
      prev.text += text
      prev.end = Math.max(prev.end, end)
      continue
    }
    words.push({
      start: from / 1000,
      end,
      text,
    })
  }
  words.sort((a, b) => a.start - b.start)
  return {
    language: String(data?.result?.language || '').trim(),
    words,
  }
}

function createCaptionWhisperService({ app, ffmpegPath, getMainWindow }) {
  let installInFlight = false
  let transcribeInFlight = false
  const progressListeners = new Set()

  const sendProgress = (payload) => {
    for (const listener of progressListeners) { try { listener(payload) } catch { /* observer only */ } }
    try {
      const win = typeof getMainWindow === 'function' ? getMainWindow() : null
      if (win && !win.isDestroyed()) {
        win.webContents.send(PROGRESS_CHANNEL, payload)
      }
    } catch { /* renderer gone — ignore */ }
  }

  async function install(options = {}) {
    const modelId = WHISPER_MODELS[options.modelId] ? options.modelId : DEFAULT_MODEL_ID
    if (installInFlight) {
      return { success: false, error: 'A caption engine install is already running.' }
    }
    installInFlight = true
    try {
      const download = ENGINE_BINARY_DOWNLOADS[process.platform]
      if (!download) {
        return { success: false, error: `The local caption engine is not available for ${process.platform} yet.` }
      }

      const binDir = engineBinDir(app)
      const modelsDir = engineModelsDir(app)
      await ensureDir(binDir)
      await ensureDir(modelsDir)

      let binaryPath = findBinaryIn(binDir)
      if (!binaryPath) {
        sendProgress({ phase: 'download-binary', message: 'Downloading caption engine…', percent: 0 })
        const archivePath = path.join(engineRoot(app), download.archiveName)
        await downloadFile(download.url, archivePath, {
          onProgress: ({ receivedBytes, totalBytes }) => {
            const total = totalBytes || download.approxBytes
            sendProgress({
              phase: 'download-binary',
              message: 'Downloading caption engine…',
              receivedBytes,
              totalBytes: total,
              percent: total ? Math.min(99, Math.round((receivedBytes / total) * 100)) : null,
            })
          },
        })
        sendProgress({ phase: 'extract', message: 'Unpacking caption engine…', percent: null })
        await extractArchive(archivePath, binDir)
        await fsp.unlink(archivePath).catch(() => {})
        binaryPath = findBinaryIn(binDir)
        if (!binaryPath) {
          return { success: false, error: 'The caption engine archive did not contain a whisper binary.' }
        }
        if (process.platform !== 'win32') {
          // Zip extraction does not always preserve the executable bit.
          await fsp.chmod(binaryPath, 0o755).catch(() => {})
        }
      }

      const modelSpec = WHISPER_MODELS[modelId]
      const modelPath = path.join(modelsDir, modelSpec.file)
      if (!fs.existsSync(modelPath)) {
        sendProgress({ phase: 'download-model', message: `Downloading ${modelSpec.label} model…`, percent: 0 })
        await downloadFile(`${MODEL_BASE_URL}${modelSpec.file}`, modelPath, {
          onProgress: ({ receivedBytes, totalBytes }) => {
            sendProgress({
              phase: 'download-model',
              message: `Downloading ${modelSpec.label} model…`,
              receivedBytes,
              totalBytes,
              percent: totalBytes ? Math.min(99, Math.round((receivedBytes / totalBytes) * 100)) : null,
            })
          },
        })
      }

      // Fetch the VAD model as part of install so first transcriptions get
      // accurate boundary timings without a mid-transcribe download.
      await ensureVadModel(app, sendProgress)

      sendProgress({ phase: 'done', message: 'Caption engine ready.', percent: 100 })
      return { success: true, ...buildEngineStatus(app) }
    } catch (err) {
      const error = String(err?.message || err)
      sendProgress({ phase: 'error', message: error, percent: null })
      return { success: false, error }
    } finally {
      installInFlight = false
    }
  }

  async function transcribe(options = {}) {
    if (transcribeInFlight) {
      return { success: false, error: 'A local transcription is already running.' }
    }
    transcribeInFlight = true
    const tempPaths = []
    try {
      const status = buildEngineStatus(app)
      if (!status.binaryPath) {
        return { success: false, error: 'The local caption engine is not installed.' }
      }
      const modelId = WHISPER_MODELS[options.modelId] ? options.modelId : DEFAULT_MODEL_ID
      const model = status.models.find((m) => m.id === modelId) || (options.strictModel ? null : status.models[0])
      if (!model) {
        return { success: false, error: 'No caption model is installed.' }
      }

      // Resolve the input to a file on disk.
      let inputPath = typeof options.inputPath === 'string' && options.inputPath ? options.inputPath : null
      if (!inputPath && options.mediaData) {
        const suffix = path.extname(String(options.mediaName || '')) || '.bin'
        const { dir, filePath } = tempFilePath(suffix)
        await ensureDir(dir)
        await fsp.writeFile(filePath, Buffer.from(options.mediaData))
        tempPaths.push(filePath)
        inputPath = filePath
      }
      if (!inputPath) {
        return { success: false, error: 'No input media was provided for transcription.' }
      }
      if (!fs.existsSync(inputPath)) {
        return { success: false, error: `Input media not found: ${inputPath}` }
      }

      let wavPath = inputPath
      if (!options.alreadyNormalized) {
        sendProgress({ phase: 'prepare', message: 'Extracting audio…', percent: null })
        wavPath = await normalizeToWav(ffmpegPath, inputPath)
        tempPaths.push(wavPath)
      }

      const outBase = wavPath.replace(/\.wav$/i, '') + '-out'
      tempPaths.push(`${outBase}.json`)

      const language = String(options.language || 'auto').toLowerCase() || 'auto'
      const threads = Math.max(2, Math.min(8, (os.cpus()?.length || 4) - 2))
      // Voice-activity detection: without it, whisper pins the first word at
      // ~0s and stretches boundary words across leading/trailing music, so
      // captions appear before anyone speaks. Auto-heals older installs by
      // fetching the 0.9MB model on first use.
      const vadPath = options.vad === false ? null : await ensureVadModel(app, sendProgress)
      // Vocabulary hint: whisper's initial prompt biases decoding toward
      // project words (brand names, people). Long form only — -p means
      // --processors. Whisper truncates past ~224 tokens; the cap here is a
      // guard against runaway renderer input, not the real budget.
      const vocabularyHint = String(options.vocabularyHint || '').replace(/\s+/g, ' ').trim().slice(0, 1000)
      const args = [
        '-m', model.path,
        '-f', wavPath,
        '-l', language,
        '-oj',
        '-of', outBase,
        '-ml', '1',
        '-pp',
        '-np',
        '-t', String(threads),
      ]
      if (vocabularyHint) {
        args.push('--prompt', vocabularyHint)
      }
      if (vadPath) {
        // Generous speech padding so word onsets survive the VAD boundary.
        args.push('--vad', '--vad-model', vadPath, '--vad-speech-pad-ms', '120')
      }

      sendProgress({ phase: 'transcribe', message: 'Transcribing…', percent: 0 })
      await runProcess(status.binaryPath, args, {
        timeoutMs: TRANSCRIBE_TIMEOUT_MS,
        cwd: path.dirname(status.binaryPath),
        onStderrLine: (line) => {
          const match = line.match(/progress\s*=\s*(\d+)%/i)
          if (match) {
            sendProgress({ phase: 'transcribe', message: 'Transcribing…', percent: Math.min(99, Number(match[1])) })
          }
        },
      })

      const rawJson = await fsp.readFile(`${outBase}.json`, 'utf8')
      const parsed = parseWhisperJson(rawJson)
      sendProgress({ phase: 'done', message: 'Transcription complete.', percent: 100 })

      return {
        success: true,
        modelId,
        releaseTag: WHISPER_RELEASE_TAG,
        language: parsed.language,
        words: parsed.words,
      }
    } catch (err) {
      const error = String(err?.message || err)
      sendProgress({ phase: 'error', message: error, percent: null })
      return { success: false, error }
    } finally {
      transcribeInFlight = false
      for (const p of tempPaths) {
        fsp.unlink(p).catch(() => {})
      }
    }
  }

  async function removeModel(options = {}) {
    const modelId = String(options.modelId || '')
    const spec = WHISPER_MODELS[modelId]
    if (!spec) {
      return { success: false, error: `Unknown caption model: ${modelId}` }
    }
    if (installInFlight || transcribeInFlight) {
      return { success: false, error: 'The caption engine is busy — try again in a moment.' }
    }
    try {
      const modelPath = path.join(engineModelsDir(app), spec.file)
      if (!fs.existsSync(modelPath)) {
        return { success: false, error: 'That model is not installed.' }
      }
      const sizeBytes = fs.statSync(modelPath).size
      await fsp.unlink(modelPath)
      return { success: true, modelId, freedBytes: sizeBytes, ...buildEngineStatus(app) }
    } catch (err) {
      return { success: false, error: String(err?.message || err) }
    }
  }

  return {
    getStatus: () => ({ ...buildEngineStatus(app), installInFlight, transcribeInFlight }),
    onProgress: listener => { progressListeners.add(listener); return () => progressListeners.delete(listener) },
    install,
    transcribe,
    removeModel,
  }
}

function registerCaptionWhisperHandlers({ app, ipcMain, ffmpegPath, getMainWindow }) {
  const service = createCaptionWhisperService({ app, ffmpegPath, getMainWindow })

  ipcMain.handle('captions:whisperStatus', () => {
    try {
      return service.getStatus()
    } catch (err) {
      return { success: false, error: String(err?.message || err) }
    }
  })

  ipcMain.handle('captions:whisperInstall', (event, options = {}) => service.install(options))
  ipcMain.handle('captions:whisperTranscribe', (event, options = {}) => service.transcribe(options))
  ipcMain.handle('captions:whisperRemoveModel', (event, options = {}) => service.removeModel(options))

  return service
}

module.exports = {
  registerCaptionWhisperHandlers,
  createCaptionWhisperService,
  parseWhisperJson,
  WHISPER_MODELS,
  WHISPER_RELEASE_TAG,
  ENGINE_BINARY_DOWNLOADS,
  MODEL_BASE_URL,
  VAD_MODEL_URL,
}
