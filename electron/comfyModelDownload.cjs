// ComfyUI's own "Download" button for a missing model, handled by Velorn.
//
// Inside Velorn, ComfyUI runs in a frame. Its Download button normally opens
// the model's address as a new tab and leaves the rest to the browser. That
// depended on how the browser engine treats such a link, and in the dev copy
// the click was dropped without a word (traced 2026-11-12: the button was
// pressed, ComfyUI clicked the link, nothing followed).
//
// ComfyUI has an official hand-off for desktop hosts: if the page has
// `window.__comfyDesktop2.downloadModel(url, name, folder)`, the button calls
// that instead. Velorn provides it (FRAME_HOOK below), so the request arrives
// here with the folder ComfyUI wants the file in. The file goes straight into
// that models folder, with progress in Velorn's download indicator. No file
// picker, and no reliance on the link click.
const path = require('path')

const ALLOWED_HOSTS = ['huggingface.co', 'civitai.com', 'civitai.red']
const MODEL_EXTENSIONS = ['.safetensors', '.sft', '.ckpt', '.pth', '.pt', '.gguf', '.bin', '.onnx']

// Runs inside the ComfyUI frame. It only passes the request to the Velorn page
// around it and waits for the answer, so ComfyUI can show an error if it fails.
const FRAME_HOOK = `(() => {
  if (window.__velornModelDownloadHook) return 'already'
  window.__velornModelDownloadHook = true
  const waiting = new Map()
  window.addEventListener('message', (event) => {
    const data = event.data
    if (!data || data.source !== 'velorn-host' || data.type !== 'download-model-answer') return
    const entry = waiting.get(data.id)
    if (!entry) return
    waiting.delete(data.id)
    if (data.ok) entry.resolve(true)
    else entry.reject(new Error(data.error || 'Velorn could not start the download.'))
  })
  const host = window.__comfyDesktop2 || {}
  host.downloadModel = (url, name, directory) => new Promise((resolve, reject) => {
    const id = 'dl-' + Date.now() + '-' + Math.random().toString(36).slice(2)
    waiting.set(id, { resolve, reject })
    window.parent.postMessage({ source: 'velorn-comfy-frame', type: 'download-model', id, url: String(url || ''), name: String(name || ''), directory: String(directory || '') }, '*')
    setTimeout(() => { if (waiting.delete(id)) reject(new Error('Velorn did not answer the download request.')) }, 20000)
  })
  window.__comfyDesktop2 = host
  return 'installed'
})()`

const fault = (error) => ({ success: false, error })

function hostAllowed(hostname) {
  const host = String(hostname || '').toLowerCase()
  return ALLOWED_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
}

// Checks a request before anything is fetched or written.
function checkRequest({ url, name, directory } = {}) {
  let parsed = null
  try { parsed = new URL(String(url || '')) } catch { return fault('That download address is not valid.') }
  if (parsed.protocol !== 'https:') return fault('Model downloads must use a secure (https) address.')
  if (!hostAllowed(parsed.hostname)) return fault(`Velorn only downloads models from ${ALLOWED_HOSTS.join(', ')}.`)
  const filename = String(name || '').trim()
  if (!filename || filename !== path.basename(filename) || /[\\/:*?"<>|\x00-\x1f]/.test(filename) || filename.startsWith('.')) {
    return fault('That model file name is not valid.')
  }
  if (!MODEL_EXTENSIONS.includes(path.extname(filename).toLowerCase())) return fault('That file is not a model file Velorn recognises.')
  const folder = String(directory || '').trim()
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(folder)) return fault('ComfyUI did not say which models folder this file belongs in.')
  return { success: true, url: parsed.toString(), filename, folder }
}

// Loopback pages only: a ComfyUI on another computer keeps its own models.
function isLocalComfyFrameUrl(url) {
  try {
    const parsed = new URL(String(url || ''))
    return parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
  } catch { return false }
}

function createComfyModelDownloads({ resolveFolder, fetchImpl, fs, createWriteStream, notify = () => {}, now = Date.now } = {}) {
  const active = new Map() // target path -> download id
  let counter = 0

  async function run({ id, url, filename, targetPath }) {
    const startedAt = now()
    const tempPath = `${targetPath}.${process.pid}.${startedAt}.download`
    let receivedBytes = 0
    let totalBytes = 0
    let lastSent = 0
    const send = (state, done = false) => notify({
      id, filename, savePath: targetPath, state, receivedBytes, totalBytes, startedAt, done,
      percent: totalBytes > 0 ? Math.max(0, Math.min(100, Math.round((receivedBytes / totalBytes) * 100))) : (done && state === 'completed' ? 100 : null),
    })
    try {
      send('downloading')
      const response = await fetchImpl(url)
      if (!response.ok) throw new Error(`The model site answered ${response.status}.`)
      totalBytes = Number(response.headers.get('content-length')) || 0
      await fs.mkdir(path.dirname(targetPath), { recursive: true })
      await new Promise((resolve, reject) => {
        const out = createWriteStream(tempPath)
        out.on('error', reject)
        out.on('finish', resolve)
        ;(async () => {
          try {
            for await (const chunk of response.body) {
              receivedBytes += chunk.length
              if (!out.write(chunk)) await new Promise((drained) => out.once('drain', drained))
              if (now() - lastSent >= 500) { lastSent = now(); send('downloading') }
            }
            out.end()
          } catch (error) { out.destroy(); reject(error) }
        })()
      })
      if (totalBytes > 0 && receivedBytes !== totalBytes) throw new Error('The download stopped before the whole file arrived.')
      await fs.rename(tempPath, targetPath)
      send('completed', true)
      console.log('[comfy model download] saved:', targetPath)
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => {})
      send('interrupted', true)
      console.warn('[comfy model download] failed:', filename, error?.message || error)
    } finally {
      active.delete(targetPath)
    }
  }

  // Answers as soon as the download has started; the file arrives in the background.
  async function start(request) {
    const checked = checkRequest(request)
    if (!checked.success) return checked
    let destination = null
    try { destination = await resolveFolder(checked.folder) } catch (error) { return fault(error?.message || 'Velorn could not find your ComfyUI models folder.') }
    if (!destination?.folder) return fault(destination?.error || 'Velorn does not know where your ComfyUI folder is yet. Set it in Settings, then try again.')
    if (destination.available === false) return fault(`The folder ${destination.folder} is not there right now. Connect that drive or fix the path, then try again.`)
    const targetPath = path.join(destination.folder, checked.filename)
    if (active.has(targetPath)) return { success: true, alreadyDownloading: true, targetPath }
    try {
      await fs.access(targetPath)
      notify({ id: `comfy-model-${now()}-${++counter}`, filename: checked.filename, savePath: targetPath, state: 'completed', receivedBytes: 0, totalBytes: 0, percent: 100, startedAt: now(), done: true })
      return { success: true, alreadyThere: true, targetPath }
    } catch { /* not there yet: download it */ }
    const id = `comfy-model-${now()}-${++counter}`
    active.set(targetPath, id)
    void run({ id, url: checked.url, filename: checked.filename, targetPath })
    return { success: true, id, targetPath }
  }

  return { start }
}

module.exports = { createComfyModelDownloads, checkRequest, isLocalComfyFrameUrl, FRAME_HOOK, ALLOWED_HOSTS, MODEL_EXTENSIONS }
