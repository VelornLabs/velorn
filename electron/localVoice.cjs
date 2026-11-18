'use strict'
// The built-in local voice model (Kokoro 82M v1.0, Apache-2.0).
//
// It runs inside Velorn's own window, with no ComfyUI and no graphics card. This
// file keeps its files: it downloads them once into Velorn's data folder, checks
// each one against a known size and SHA-256, and hands the bytes to the window
// that speaks with them. Every file is pinned to an exact published version, so
// what is run is what was reviewed.
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { createHash } = require('node:crypto')

const MODEL = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/'
// The engine the model runs on (ONNX Runtime for the web, MIT), the exact build the bundled library expects.
const RUNTIME = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0-dev.20250409-89f8206ba4/dist/'
const file = (name, bytes, sha256, base = MODEL) => Object.freeze({ path: name, bytes, sha256, url: base + name })
const FILES = Object.freeze([
  file('onnx/model_quantized.onnx', 92361116, 'fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478'),
  file('ort-wasm-simd-threaded.jsep.wasm', 21596019, 'c46655e8a94afc45338d4cb2b840475f88e5012d524509916e505079c00bfa39', RUNTIME),
  file('config.json', 44, 'df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f'),
  file('tokenizer.json', 3497, '77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34'),
  file('tokenizer_config.json', 113, 'be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20'),
  file('voices/af_heart.bin', 522240, 'd583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b'),
  file('voices/af_bella.bin', 522240, 'f69d836209b78eb8c66e75e3cda491e26ea838a3674257e9d4e5703cbaf55c8b'),
  file('voices/af_nicole.bin', 522240, 'cd2191ab31b914ed7b318416b0e4440fdf392ddad9106a060819aa600a64f59a'),
  file('voices/af_sarah.bin', 522240, '4409fbc125afabacc615d94db5398d847006a737b0247d6892b7a9a0007a2f0a'),
  file('voices/am_michael.bin', 522240, '1d1f21dd8da39c30705cd4c75d039d265e9bc4a2a93ed09bc9e1b1225eb95ba1'),
  file('voices/am_fenrir.bin', 522240, 'c27989f741f7ee34d273a39d8a595cc0837d35f5ced9a29b7cc162614616df43'),
  file('voices/am_puck.bin', 522240, 'fcf73c989033e9233e0b98713eca600c8c74dcc1614b37009d5450ff4a2274a0'),
  file('voices/bf_emma.bin', 522240, '669fe0647f9dd04fcab92f1439a40eeb4c8b4ab1f82e4996fe3d918ce4a63b73'),
  file('voices/bm_george.bin', 522240, 'c4b235a4c1f2cd3b939fed08b899ce9385638b763f7b73a59616c4fc9bd6c9bc'),
  file('voices/bm_fable.bin', 522240, 'f889083196807b4adb15e9204252165f503b8d33d3982e681c52443c49d798f1'),
])
const TOTAL_BYTES = FILES.reduce((sum, item) => sum + item.bytes, 0)
const byPath = new Map(FILES.map(item => [item.path, item]))

function createLocalVoice({ dir, fetchImpl = globalThis.fetch, notify = () => {} } = {}) {
  if (typeof dir !== 'string' || !dir) throw new TypeError('dir is required.')
  const place = item => path.join(dir, ...item.path.split('/'))
  let installing = null, progress = null

  // A file counts once it is there at exactly the right size. Its contents were
  // checked when it was downloaded, and are checked again before it is used.
  async function present(item) {
    try { return (await fsp.stat(place(item))).size === item.bytes } catch { return false }
  }
  async function status() {
    const have = await Promise.all(FILES.map(present))
    const doneBytes = FILES.reduce((sum, item, index) => sum + (have[index] ? item.bytes : 0), 0)
    return { success: true, installed: have.every(Boolean), installing: Boolean(installing), totalBytes: TOTAL_BYTES, doneBytes,
      files: FILES.length, folder: dir, ...(progress ? { progress: { ...progress } } : {}) }
  }

  async function download(item, before) {
    const target = place(item), part = `${target}.part`
    await fsp.mkdir(path.dirname(target), { recursive: true })
    const response = await fetchImpl(item.url, { redirect: 'follow' })
    if (!response.ok || !response.body) throw new Error(`The download server answered ${response.status} for ${item.path}.`)
    const hash = createHash('sha256'), out = fs.createWriteStream(part)
    let got = 0, last = 0
    try {
      for await (const chunk of response.body) {
        got += chunk.length
        if (got > item.bytes) throw new Error(`${item.path} is larger than expected.`)
        hash.update(chunk)
        if (!out.write(chunk)) await new Promise(resolve => out.once('drain', resolve))
        if (Date.now() - last > 200) { last = Date.now(); progress = { doneBytes: before + got, totalBytes: TOTAL_BYTES, current: item.path }; notify({ ...progress }) }
      }
      await new Promise((resolve, reject) => out.end(error => (error ? reject(error) : resolve())))
      if (got !== item.bytes || hash.digest('hex') !== item.sha256) throw new Error(`${item.path} did not match the expected file. It was not kept.`)
      await fsp.rename(part, target)
    } catch (error) {
      out.destroy()
      await fsp.rm(part, { force: true }).catch(() => {})
      throw error
    }
  }

  // Downloads whatever is missing. One at a time; a second call joins the first.
  function install() {
    if (!installing) installing = (async () => {
      try {
        let before = 0
        for (const item of FILES) {
          if (!await present(item)) await download(item, before)
          before += item.bytes
          progress = { doneBytes: before, totalBytes: TOTAL_BYTES, current: item.path }; notify({ ...progress })
        }
        return { success: true }
      } catch (error) {
        return { success: false, error: error?.message || 'The download did not finish.' }
      } finally { installing = null; progress = null }
    })()
    return installing.then(async result => ({ ...(await status()), ...result }))
  }

  // The bytes of one known file, checked again before they are run or spoken with.
  async function read(payload) {
    const item = byPath.get(typeof payload?.path === 'string' ? payload.path : '')
    if (!item) return { success: false, error: 'That is not one of the voice model files.' }
    try {
      const bytes = await fsp.readFile(place(item))
      if (bytes.length !== item.bytes || createHash('sha256').update(bytes).digest('hex') !== item.sha256) {
        await fsp.rm(place(item), { force: true }).catch(() => {})
        return { success: false, damaged: true, error: 'A voice model file was damaged and has been removed. Download the voice model again.' }
      }
      return { success: true, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length) }
    } catch { return { success: false, missing: true, error: 'The voice model is not downloaded yet.' } }
  }

  return { status, install, read }
}

function registerLocalVoiceIpc({ ipcMain, getMainWindow, dir, fetchImpl }) {
  const voice = createLocalVoice({ dir, fetchImpl, notify: value => {
    const window = getMainWindow()
    if (window && !window.isDestroyed()) window.webContents.send('local-voice:progress', value)
  } })
  const fromMainWindow = event => { const window = getMainWindow(); return Boolean(window && !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame) }
  const guard = handler => async (event, payload) => {
    if (!fromMainWindow(event)) return { success: false, error: 'Not available here.' }
    try { return await handler(payload) } catch (error) { return { success: false, error: error?.message || 'The voice model is not available.' } }
  }
  ipcMain.handle('local-voice:status', guard(() => voice.status()))
  ipcMain.handle('local-voice:install', guard(() => voice.install()))
  ipcMain.handle('local-voice:read', guard(payload => voice.read(payload)))
  return voice
}

module.exports = { createLocalVoice, registerLocalVoiceIpc, FILES, TOTAL_BYTES }
