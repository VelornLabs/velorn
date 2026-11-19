// Speaks text with the built-in Kokoro voice model, off the main thread.
//
// The model's library expects to fetch its files from the internet. Here they
// come from Velorn's own checked copy instead: every request for a model file
// is answered with bytes the page hands over (it gets them from the main
// process, which verified them). Nothing is fetched from the network here.
import { splitForSpeech } from './voiceText.mjs'
// The engine's loader script, as a file of its own: its extra threads start from it.
import engineLoaderUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs?url'

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX'
const PREFIX = `https://huggingface.co/${MODEL_ID}/resolve/main/`
const RATE = 24000
const waiting = new Map()
let nextId = 0

const fileFromPage = path => new Promise((resolve, reject) => {
  const id = ++nextId
  waiting.set(id, { resolve, reject })
  self.postMessage({ type: 'file', id, path })
})

// The model's library reads downloads with `for await` over a stream. Velorn's Electron
// version (Chromium 120) cannot do that yet, and without this the library waits forever.
if (typeof ReadableStream !== 'undefined' && !ReadableStream.prototype[Symbol.asyncIterator]) {
  ReadableStream.prototype[Symbol.asyncIterator] = async function* () {
    const reader = this.getReader()
    try { for (;;) { const { done, value } = await reader.read(); if (done) return; yield value } } finally { reader.releaseLock() }
  }
}

const networkFetch = self.fetch.bind(self)
self.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input?.url || String(input)
  if (!url.startsWith(PREFIX)) return networkFetch(input, init)
  try {
    const bytes = await fileFromPage(decodeURIComponent(url.slice(PREFIX.length).split('?')[0]))
    return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.byteLength), 'content-type': 'application/octet-stream' } })
  } catch { return new Response(null, { status: 404 }) }
}

let ready = null
function load() {
  if (!ready) ready = (async () => {
    // Imported only now, so the library sees the fetch above.
    const { env } = await import('@huggingface/transformers')
    env.allowLocalModels = false
    env.useBrowserCache = false
    const wasm = env.backends.onnx.wasm
    wasm.wasmBinary = await fileFromPage('ort-wasm-simd-threaded.jsep.wasm')
    // Several threads make speech two to three times faster. They need shared memory, which the
    // desktop app switches on for itself; anywhere it is missing, one thread is used.
    const shared = typeof SharedArrayBuffer === 'function'
    if (shared) wasm.wasmPaths = { mjs: new URL(engineLoaderUrl, self.location.href).href }
    wasm.numThreads = shared ? Math.max(1, Math.min(6, (self.navigator?.hardwareConcurrency || 2) - 1)) : 1
    wasm.proxy = false
    const { KokoroTTS } = await import('kokoro-js')
    return KokoroTTS.from_pretrained(MODEL_ID, { dtype: 'q8', device: 'wasm' })
  })().catch(error => { ready = null; throw error })
  return ready
}

// 16-bit mono WAV.
function wav(samples) {
  const out = new DataView(new ArrayBuffer(44 + samples.length * 2))
  const text = (at, value) => { for (let i = 0; i < value.length; i++) out.setUint8(at + i, value.charCodeAt(i)) }
  text(0, 'RIFF'); out.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVEfmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true)
  out.setUint32(24, RATE, true); out.setUint32(28, RATE * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true); text(36, 'data'); out.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) { const v = Math.max(-1, Math.min(1, samples[i])); out.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true) }
  return out.buffer
}

async function speak({ id, text, voice }) {
  const tts = await load()
  // Long text is spoken a sentence or two at a time and joined, which this model needs.
  // The library's own streaming helper is not used: it relies on a browser feature
  // that Velorn's Electron version does not have, and it then waits forever.
  const pieces = splitForSpeech(text)
  const gap = new Float32Array(Math.round(RATE * 0.12)) // a short breath between pieces
  const parts = []
  for (let i = 0; i < pieces.length; i++) {
    const spoken = await tts.generate(pieces[i], { voice })
    if (parts.length) parts.push(gap)
    parts.push(spoken.audio)
    self.postMessage({ type: 'progress', id, done: i + 1, total: pieces.length })
  }
  const length = parts.reduce((sum, part) => sum + part.length, 0)
  if (!length) throw new Error('The voice model made no sound for this text.')
  const samples = new Float32Array(length)
  let at = 0
  for (const part of parts) { samples.set(part, at); at += part.length }
  return { bytes: wav(samples), seconds: length / RATE }
}

// Anything that fails outside a request still ends the request it belongs to, with a message.
let current = null
self.addEventListener('unhandledrejection', event => {
  if (current !== null) { self.postMessage({ type: 'done', id: current, error: event.reason?.message || 'The voice model stopped unexpectedly.' }); current = null }
})

self.onmessage = async event => {
  const message = event.data || {}
  if (message.type === 'file-reply') {
    const asked = waiting.get(message.id); waiting.delete(message.id)
    if (asked) message.bytes ? asked.resolve(message.bytes) : asked.reject(new Error(message.error || 'File not available.'))
    return
  }
  if (message.type !== 'speak' && message.type !== 'load') return
  current = message.id
  try {
    if (message.type === 'load') { await load(); self.postMessage({ type: 'done', id: message.id }); return }
    const made = await speak(message)
    self.postMessage({ type: 'done', id: message.id, bytes: made.bytes, seconds: made.seconds }, [made.bytes])
  } catch (error) {
    self.postMessage({ type: 'done', id: message.id, error: error?.message || 'The voice could not be made.' })
  } finally { if (current === message.id) current = null }
}
