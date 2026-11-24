// Song listening worker: turns a song file into timed lyric lines.
//
// Runs as its own Node process (started by songMapEngine.cjs) because the
// work is heavy: about as long as the song on a processor alone, and a few
// gigabytes of memory. It needs no Python and no ComfyUI:
//   1. ffmpeg decodes the song
//   2. a vocal separator (MDX-Net, ONNX) pulls out the voice
//   3. whisper-cli hears the words, only where there is a voice
//   4. an aligner (wav2vec2 CTC, ONNX) places every word in time
// The request arrives as one JSON argument; progress and the result leave as
// JSON lines on stdout.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, spawnSync } = require('child_process')

const request = JSON.parse(process.argv[2] || '{}')
const ort = require(request.onnxRuntimePath || 'onnxruntime-node')
const THREADS = Math.max(1, Number(request.threads) || 4)
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n')
const progress = (step, fraction) => send({ type: 'progress', step, percent: Math.max(0, Math.min(100, Math.round(fraction * 100))) })

// `enableMemPattern: false` is required: with the default, the second run of
// a model crashes the process when this worker runs on Electron's own Node
// (it is fine on plain Node). Found the hard way; do not remove.
const sessionOptions = (threads) => ({ intraOpNumThreads: threads, enableMemPattern: false })

// The two models (voice separator, word aligner) run on the graphics card when the engine's own
// built-in route for that (WebGPU, part of onnxruntime-node, nothing to download) works on this
// computer, and on the processor otherwise. Every way the card can let us down ends on the processor:
//   - no usable card or driver: the card session cannot be made;
//   - a card that cannot run the model: the run throws, and that same piece is run again on the processor;
//   - a "card" that is really slower than the processor: its second piece is timed against the processor once.
// `request.useCard === false` (set after a failed attempt) skips the card altogether.
const ranOn = {}
async function openModel(modelPath, threads, name) {
  const onProcessor = () => ort.InferenceSession.create(modelPath, sessionOptions(threads))
  const state = { on: 'processor', sess: null }
  ranOn[name] = state
  if (request.useCard !== false) {
    try { state.sess = await ort.InferenceSession.create(modelPath, { ...sessionOptions(threads), executionProviders: ['webgpu'] }); state.on = 'card' }
    catch { state.problem = 'unavailable' }
  }
  if (!state.sess) state.sess = await onProcessor()
  let runs = 0
  state.run = async (feeds) => {
    if (state.on !== 'card') return state.sess.run(feeds)
    const started = performance.now()
    let out
    try { out = await state.sess.run(feeds) }
    catch { state.on = 'processor'; state.problem = 'failed'; state.sess = await onProcessor(); return state.sess.run(feeds) }
    runs++
    const cardMs = performance.now() - started
    if (runs === 2 && cardMs > 1000) {
      const plain = await onProcessor(), again = performance.now(), same = await plain.run(feeds)
      if (performance.now() - again < cardMs) { state.on = 'processor'; state.problem = 'slower'; state.sess = plain; return same }
    }
    return out
  }
  return state
}

function ffmpeg(args, input) {
  const r = spawnSync(request.ffmpegPath, ['-loglevel', 'error', ...args], { input, maxBuffer: 1 << 30, windowsHide: true })
  if (r.status !== 0) throw new Error('The song could not be read: ' + String(r.stderr || r.error || '').slice(-300))
  return r.stdout
}
const f32 = (buf) => new Float32Array(buf.buffer, buf.byteOffset, buf.length >> 2).slice()
const i16 = (buf) => new Int16Array(buf.buffer, buf.byteOffset, buf.length >> 1).slice()

// `binary` is the speech program to run. With `needsCard`, it is the graphics-card version: it must find a real
// card. If it says it found none (it would then quietly work on the processor, which the plain version does
// better), it is stopped at once and the caller falls back.
function runWhisper(args, onPercent, { binary = request.whisperCliPath, needsCard = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: path.dirname(binary), windowsHide: true })
    let tail = '', noCard = false
    child.stderr.on('data', (chunk) => {
      tail = (tail + chunk.toString()).slice(-2000)
      if (needsCard && !noCard && /no GPU found|No devices found/i.test(tail)) { noCard = true; try { child.kill() } catch { /* Already gone. */ } }
      const match = tail.match(/progress\s*=\s*(\d+)%(?![\s\S]*progress\s*=)/i)
      if (match) onPercent(Number(match[1]) / 100)
    })
    child.stdout.on('data', () => {})
    child.on('error', reject)
    child.on('close', (code) => (noCard ? reject(Object.assign(new Error('no graphics card'), { noCard: true }))
      : code === 0 ? resolve() : reject(new Error('The speech engine stopped: ' + tail.slice(-300)))))
  })
}
// Which language the song is sung in, as the speech program hears it in the first half minute of singing.
// English when it is not sure, or cannot tell (an English-only speech model, or any failure).
function detectLanguage(file) {
  return new Promise((resolve) => {
    let said = ''
    const done = () => { const match = said.match(/auto-detected language:\s*([a-z]{2,3})\s*\(p\s*=\s*([\d.]+)\)/i); resolve(match && Number(match[2]) >= 0.5 ? match[1].toLowerCase() : 'en') }
    try {
      const child = spawn(request.whisperCliPath, ['-m', request.whisperModelPath, '-f', file, '-dl', '-l', 'auto', '-t', String(THREADS)], { cwd: path.dirname(request.whisperCliPath), windowsHide: true })
      const timer = setTimeout(() => { try { child.kill() } catch { /* Already gone. */ } }, 120000)
      child.stderr.on('data', (chunk) => { said = (said + chunk.toString()).slice(-4000) })
      child.stdout.on('data', (chunk) => { said = (said + chunk.toString()).slice(-4000) })
      child.on('error', () => { clearTimeout(timer); resolve('en') })
      child.on('close', () => { clearTimeout(timer); done() })
    } catch { resolve('en') }
  })
}
// Hears the words on the graphics card when Velorn has that version of the speech program, and on the processor
// otherwise or when the card version fails for any reason. What happened is reported with the result.
const speech = { used: 'processor' }
async function hearWords(args, onPercent, resultFile) {
  const card = request.whisperGpuCliPath
  if (card) {
    try {
      // The quiet flag is left out here so the program says which card it uses.
      await runWhisper(args.filter(item => item !== '-np'), onPercent, { binary: card, needsCard: true })
      if (fs.existsSync(resultFile)) { speech.used = 'card'; return }
      speech.cardProblem = 'failed'
    } catch (error) { speech.cardProblem = error?.noCard ? 'no-card' : 'failed' }
    try { fs.rmSync(resultFile, { force: true }) } catch { /* Nothing was written. */ }
    onPercent(0)
  }
  await runWhisper(args, onPercent)
}

const DICT = JSON.parse(fs.readFileSync(request.alignerDictPath, 'utf8'))
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'velorn-song-'))
const T = {}
const tick = () => performance.now()

// ---------- FFT of size 7680 = 15 x 512 ----------
const NFFT = 7680, HOP = 1024, BINS = NFFT / 2 + 1, DIMF = 3072, DIMT = 256
const R = 15, M = 512, LOG = 9
const rev = new Uint16Array(M)
for (let i = 0; i < M; i++) { let r = 0; for (let b = 0; b < LOG; b++) r |= ((i >> b) & 1) << (LOG - 1 - b); rev[i] = r }
const cosM = new Float64Array(M / 2), sinM = new Float64Array(M / 2)
for (let i = 0; i < M / 2; i++) { cosM[i] = Math.cos(-2 * Math.PI * i / M); sinM[i] = Math.sin(-2 * Math.PI * i / M) }
const cosN = new Float64Array(NFFT), sinN = new Float64Array(NFFT)
for (let i = 0; i < NFFT; i++) { cosN[i] = Math.cos(-2 * Math.PI * i / NFFT); sinN[i] = Math.sin(-2 * Math.PI * i / NFFT) }
const subRe = new Float64Array(R * M), subIm = new Float64Array(R * M)
function fft512(re, im, off) {
  for (let i = 0; i < M; i++) { const j = rev[i]; if (j > i) { let t = re[off + i]; re[off + i] = re[off + j]; re[off + j] = t; t = im[off + i]; im[off + i] = im[off + j]; im[off + j] = t } }
  for (let size = 2; size <= M; size <<= 1) {
    const half = size >> 1, step = M / size
    for (let s = 0; s < M; s += size) for (let k = 0; k < half; k++) {
      const c = cosM[k * step], sn = sinM[k * step], a = off + s + k, b = a + half
      const xr = re[b] * c - im[b] * sn, xi = re[b] * sn + im[b] * c
      re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi
    }
  }
}
// forward DFT of length NFFT; writes the first `nOut` bins
function fftN(inRe, inIm, outRe, outIm, nOut) {
  for (let r = 0; r < R; r++) { const o = r * M; for (let k = 0; k < M; k++) { subRe[o + k] = inRe[r + R * k]; subIm[o + k] = inIm ? inIm[r + R * k] : 0 } fft512(subRe, subIm, o) }
  for (let k = 0; k < nOut; k++) {
    const km = k & (M - 1); let ar = 0, ai = 0
    for (let r = 0; r < R; r++) { const w = (r * k) % NFFT, c = cosN[w], s = sinN[w], xr = subRe[r * M + km], xi = subIm[r * M + km]; ar += xr * c - xi * s; ai += xr * s + xi * c }
    outRe[k] = ar; outIm[k] = ai
  }
}
const win = new Float64Array(NFFT); for (let i = 0; i < NFFT; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / NFFT)

// ---------- vocal separation (MDX-Net model, UVR chunking) ----------
async function separate(stereo, n, modelPath, threads, onProgress) {
  const model = await openModel(modelPath, threads, 'voice')
  const TRIM = NFFT / 2, CHUNK = HOP * (DIMT - 1), GEN = CHUNK - 2 * TRIM
  const padEnd = GEN + TRIM - (n % GEN), total = TRIM + n + padEnd
  const ch = [new Float32Array(total), new Float32Array(total)]
  for (let i = 0; i < n; i++) { ch[0][TRIM + i] = stereo[2 * i]; ch[1][TRIM + i] = stereo[2 * i + 1] }
  const out = [new Float32Array(n), new Float32Array(n)]
  const frame = new Float64Array(NFFT), fRe = new Float64Array(NFFT), fIm = new Float64Array(NFFT), tRe = new Float64Array(NFFT), tIm = new Float64Array(NFFT)
  const padded = new Float64Array(CHUNK + NFFT), ola = new Float64Array(CHUNK + NFFT), wsum = new Float64Array(CHUNK + NFFT)
  for (let t = 0; t < DIMT; t++) for (let i = 0; i < NFFT; i++) wsum[t * HOP + i] += win[i] * win[i]
  const plane = DIMF * DIMT
  const chunkCount = Math.max(1, Math.floor((total - CHUNK) / GEN) + 1)
  for (let start = 0, ci = 0; start + CHUNK <= total; start += GEN, ci++) {
    onProgress(ci / chunkCount)
    const x = new Float32Array(4 * plane)
    for (let c = 0; c < 2; c++) {
      const src = ch[c]
      for (let i = 0; i < CHUNK; i++) padded[TRIM + i] = src[start + i]
      for (let i = 0; i < TRIM; i++) { padded[TRIM - 1 - i] = src[start + 1 + i]; padded[TRIM + CHUNK + i] = src[start + CHUNK - 2 - i] }
      for (let t = 0; t < DIMT; t++) {
        const o = t * HOP
        for (let i = 0; i < NFFT; i++) frame[i] = padded[o + i] * win[i]
        fftN(frame, null, fRe, fIm, DIMF)
        for (let f = 0; f < DIMF; f++) { x[(2 * c) * plane + f * DIMT + t] = fRe[f]; x[(2 * c + 1) * plane + f * DIMT + t] = fIm[f] }
      }
    }
    const res = await model.run({ input: new ort.Tensor('float32', x, [1, 4, DIMF, DIMT]) })
    const y = res.output.data
    for (let c = 0; c < 2; c++) {
      ola.fill(0)
      for (let t = 0; t < DIMT; t++) {
        // inverse via conj(fft(conj(X)))/N with Hermitian fill; bins >= DIMF are zero
        fRe.fill(0); fIm.fill(0)
        for (let f = 0; f < DIMF; f++) {
          const re = y[(2 * c) * plane + f * DIMT + t], im = y[(2 * c + 1) * plane + f * DIMT + t]
          fRe[f] = re; fIm[f] = -im
          if (f > 0) { fRe[NFFT - f] = re; fIm[NFFT - f] = im }
        }
        fftN(fRe, fIm, tRe, tIm, NFFT)
        const o = t * HOP
        for (let i = 0; i < NFFT; i++) ola[o + i] += (tRe[i] / NFFT) * win[i]
      }
      for (let i = TRIM; i < CHUNK - TRIM; i++) {
        const g = start + i - TRIM
        if (g < n) out[c][g] = (ola[TRIM + i] / wsum[TRIM + i]) * 1.009
      }
    }
  }
  const mono = new Float32Array(n); for (let i = 0; i < n; i++) mono[i] = 0.5 * (out[0][i] + out[1][i])
  return mono
}

// ---------- helpers shared with v2 ----------
// The word timer only knows the letters a to z. Letters with marks lose the mark (ą becomes a); the few Latin
// letters that do not come apart that way are swapped by hand, so a word such as 'łódź' is still timed whole.
// Only the timing uses this: the lyrics keep their own letters.
const PLAIN_LETTERS = { 'ł': 'l', 'ø': 'o', 'đ': 'd', 'ð': 'd', 'þ': 'th', 'ß': 'ss', 'æ': 'ae', 'œ': 'oe', 'ı': 'i', 'ħ': 'h' }
const norm = (t) => t.toLowerCase().replace(/[łøđðþßæœıħ]/g, (letter) => PLAIN_LETTERS[letter]).normalize('NFKD').replace(/[^\x00-\x7f]/g, '').replace(/[^a-z' ]/g, ' ').split(/\s+/).filter((w) => /[a-z]/.test(w))
const ts = (t) => { const ms = Math.round(t * 1000); const p = (n, l = 2) => String(n).padStart(l, '0'); return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}` }
function writeWav16(file, pcm) {
  const h = Buffer.alloc(44); h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length * 2, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length * 2, 40)
  fs.writeFileSync(file, Buffer.concat([h, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.length * 2)]))
}

// ---------- CTC forced alignment (same idea as torchaudio forced_align) ----------
function forcedAlign(em, Tn, C, tokens) {
  const L = tokens.length, S = 2 * L + 1, NEG = -1e30
  let prev = new Float32Array(S).fill(NEG), cur = new Float32Array(S)
  const back = new Uint8Array(Tn * S)
  prev[0] = em[0]; prev[1] = em[tokens[0]]
  for (let t = 1; t < Tn; t++) {
    const row = t * C, lo = Math.max(0, S - 2 * (Tn - t)), hi = Math.min(S, 2 * (t + 1))
    cur.fill(NEG)
    for (let s = lo; s < hi; s++) {
      let best = prev[s], bp = 0
      if (s > 0 && prev[s - 1] > best) { best = prev[s - 1]; bp = 1 }
      if (s > 1 && (s & 1) && tokens[(s - 1) >> 1] !== tokens[(s - 3) >> 1] && prev[s - 2] > best) { best = prev[s - 2]; bp = 2 }
      cur[s] = best + em[row + ((s & 1) ? tokens[(s - 1) >> 1] : 0)]; back[t * S + s] = bp
    }
    const tmp = prev; prev = cur; cur = tmp
  }
  let s = prev[S - 1] > prev[S - 2] ? S - 1 : S - 2
  const first = new Int32Array(L).fill(-1), last = new Int32Array(L).fill(-1), sum = new Float64Array(L), cnt = new Int32Array(L)
  for (let t = Tn - 1; t >= 0; t--) {
    if (s & 1) { const k = (s - 1) >> 1; first[k] = t; if (last[k] < 0) last[k] = t; sum[k] += Math.exp(em[t * C + tokens[k]]); cnt[k]++ }
    s -= back[t * S + s]
  }
  return { first, last, score: Array.from(sum, (v, k) => (cnt[k] ? v / cnt[k] : 0)) }
}

async function main() {
let t0 = tick()
const stereo = f32(ffmpeg(['-i', request.inputPath, '-ac', '2', '-ar', '44100', '-f', 'f32le', '-']))
const n = stereo.length / 2
const mix16 = i16(ffmpeg(['-i', request.inputPath, '-ac', '1', '-ar', '16000', '-f', 's16le', '-']))
progress('voice', 0)
const vocals = await separate(stereo, n, request.separatorModelPath, THREADS, (f) => progress('voice', f))
const voc16i = i16(ffmpeg(['-f', 'f32le', '-ar', '44100', '-ac', '1', '-i', '-', '-ar', '16000', '-f', 's16le', '-'], Buffer.from(vocals.buffer)))
const voc = new Float32Array(voc16i.length); for (let i = 0; i < voc.length; i++) voc[i] = voc16i[i] / 32768
T.separate = (tick() - t0) / 1000; t0 = tick()

// voice regions
const HOPE = 800, nE = Math.floor(voc.length / HOPE), e = new Float32Array(nE)
for (let k = 0; k < nE; k++) { let s = 0; for (let i = 0; i < HOPE; i++) { const v = voc[k * HOPE + i]; s += v * v } e[k] = Math.sqrt(s / HOPE) }
const sorted = Float32Array.from(e).sort(), p95 = sorted[Math.min(nE - 1, Math.floor(0.95 * (nE - 1)))], thr = 0.1 * p95
const act = Array.from(e, (v) => v > thr)
const anyIn = (a, b) => { for (let i = a; i < Math.min(b, nE); i++) if (act[i]) return true; return false }
const regs = []
for (let k = 0; k < nE;) {
  if (act[k]) { let j = k; while (j < nE && (act[j] || anyIn(j, j + 30))) j++; if ((j - k) * 0.05 >= 0.6) regs.push([Math.max(0, k * 0.05 - 0.4), Math.min(nE * 0.05, j * 0.05 + 0.4)]); k = j } else k++
}
const merged = []
for (const [a, b] of regs) { if (merged.length && a <= merged[merged.length - 1][1]) merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], b); else merged.push([a, b]) }
const parts = []
for (const [a, b] of merged) { parts.push(mix16.subarray(Math.floor(a * 16000), Math.floor(b * 16000))); parts.push(new Int16Array(8000)) }
const cut = new Int16Array(parts.reduce((s, p) => s + p.length, 0) || 16000); { let o = 0; for (const p of parts) { cut.set(p, o); o += p.length } }
const cutFile = path.join(work, 'cut.wav'); writeWav16(cutFile, cut)

// words
const ob = path.join(work, 'w')
progress('words', 0)
const language = request.language && request.language !== 'auto' ? request.language : await detectLanguage(cutFile)
await hearWords(['-m', request.whisperModelPath, '-f', cutFile, '-l', language, '-oj', '-of', ob, '-np', '-pp', '-t', String(THREADS), '-mc', '0'], (f) => progress('words', f), ob + '.json')
T.words = (tick() - t0) / 1000; t0 = tick()
const segs = []; let dropped = 0
for (const s of JSON.parse(fs.readFileSync(ob + '.json', 'utf8')).transcription) {
  const tx = s.text.replaceAll('♪', '').trim(), a = s.offsets.from / 1000, b = s.offsets.to / 1000
  if (!tx || /^[\[(].*[\])]$/.test(tx) || !norm(tx).length) continue
  if (b - a < 0.05) { dropped++; continue }
  if (segs.length && tx === segs[segs.length - 1][2] && b - a < 1.5) { dropped++; continue }
  segs.push([a, b, tx])
}

// align
const words = []
for (const s of segs) for (const w of norm(s[2])) words.push(w)
let rows = []
if (words.length) {
  progress('timing', 0)
  const model = await openModel(request.alignerModelPath, THREADS, 'timing'), sess = model.sess
  const C = 29, chunks = []; let Tn = 0
  for (let i = 0; i < voc.length; i += 16000 * 30) {
    if (voc.length - i < 400) break
    const a = voc.subarray(i, Math.min(voc.length, i + 16000 * 30))
    const r = await model.run({ [sess.inputNames[0]]: new ort.Tensor('float32', a, [1, a.length]) })
    const o = r[sess.outputNames[0]]; chunks.push(o.data); Tn += o.dims[1]
    progress('timing', Math.min(0.95, (i + 16000 * 30) / voc.length))
  }
  const em = new Float32Array(Tn * C); { let o = 0; for (const c of chunks) { em.set(c, o); o += c.length } }
  const tokens = [], wordOf = []
  words.forEach((w, wi) => { for (const ch of w) if (ch in DICT) { tokens.push(DICT[ch]); wordOf.push(wi) } })
  const al = forcedAlign(em, Tn, C, tokens)
  const r = voc.length / Tn / 16000
  const wt = words.map(() => [Infinity, 0, 0, 0])
  for (let k = 0; k < tokens.length; k++) { const w = wt[wordOf[k]]; w[0] = Math.min(w[0], al.first[k] * r); w[1] = Math.max(w[1], (al.last[k] + 1) * r); w[2] += al.score[k]; w[3]++ }
  for (const w of wt) w[2] = w[3] ? w[2] / w[3] : 0
  let p = 0
  for (const sg of segs) {
    const toks = []
    for (const tk of sg[2].split(/\s+/)) { const c = norm(tk).length; toks.push([tk, Array.from({ length: c }, (_, i) => p + i)]); p += c }
    const groups = [[]]
    toks.forEach(([tk, ix], q) => {
      const g = groups[groups.length - 1]; g.push([tk, ix])
      const nxtTok = toks.slice(q + 1).find(([, i2]) => i2.length), nxt = nxtTok ? nxtTok[1][0] : null, cur = ix.length ? ix[ix.length - 1] : null
      const pause = nxt !== null && cur !== null ? wt[nxt][0] - wt[cur][1] : 0
      const nw = g.reduce((s, [, i3]) => s + i3.length, 0), gi = g.filter(([, i3]) => i3.length).map(([, i3]) => i3)
      const span = gi.length ? wt[gi[gi.length - 1][gi[gi.length - 1].length - 1]][1] - wt[gi[0][0]][0] : 0
      if (q < toks.length - 1 && nw >= 3 && (pause > 1.0 || (/[.,;:!?]$/.test(tk) && (span > 4 || nw >= 8)) || (pause > 0.5 && span > 7))) groups.push([])
    })
    for (const g of groups) {
      if (!g.some(([, i3]) => i3.length)) continue
      let pend = [g]
      while (pend.length) {
        const g2 = pend.shift(), wi = g2.map(([, i3], q) => [q, i3]).filter(([, i3]) => i3.length)
        const span = wt[wi[wi.length - 1][1].at(-1)][1] - wt[wi[0][1][0]][0]
        let best = null
        for (let j = 2; j < wi.length - 3; j++) { const gap = wt[wi[j + 1][1][0]][0] - wt[wi[j][1].at(-1)][1]; if (!best || gap > best[0] || (gap === best[0] && wi[j][0] > best[1])) best = [gap, wi[j][0]] }
        if (span > 8 && best && best[0] >= 0.25) { pend = [g2.slice(0, best[1] + 1), g2.slice(best[1] + 1), ...pend]; continue }
        const ix = g2.flatMap(([, i3]) => i3), st = wt[ix[0]][0]
        rows.push({ start: +st.toFixed(2), end: +Math.max(Math.min(wt[ix.at(-1)][1], wt[ix.at(-1)][0] + 3.0), st + 0.5).toFixed(2), text: g2.map(([tk]) => tk).join(' '), conf: +(ix.reduce((s, i) => s + wt[i][2], 0) / ix.length).toFixed(2) })
      }
    }
  }
}
for (const row of rows) { const a = Math.floor(row.start * 20), b = Math.max(a + 1, Math.floor(row.end * 20)); let c = 0, m = 0; for (let i = a; i < Math.min(b, nE); i++) { c += act[i] ? 1 : 0; m++ } row.voice = m ? +(c / m).toFixed(2) : 0 }
const ghosts = rows.filter((r) => r.conf < 0.1 && r.voice < 0.2).length
rows = rows.filter((r) => !(r.conf < 0.1 && r.voice < 0.2))
T.align = (tick() - t0) / 1000

const voice = merged.map(([a, b]) => [+a.toFixed(2), +b.toFixed(2)])
send({ type: 'result', speech, language, models: Object.fromEntries(Object.entries(ranOn).map(([name, state]) => [name, { on: state.on, ...(state.problem ? { problem: state.problem } : {}) }])), duration: +(n / 44100).toFixed(2), rows, voice, droppedStutters: dropped, droppedGhosts: ghosts, seconds: Object.fromEntries(Object.entries(T).map(([k, v]) => [k, +v.toFixed(1)])) })
fs.rmSync(work, { recursive: true, force: true })
}

main().then(() => process.exit(0)).catch((error) => {
  try { fs.rmSync(work, { recursive: true, force: true }) } catch { /* nothing to clean */ }
  send({ type: 'error', error: String(error?.message || error) })
  process.exit(1)
})
