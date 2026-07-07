/**
 * Audio analysis: gives agents (and future UI) ears.
 *
 * Decodes an audio source (audio assets, or the audio track of a video) and
 * extracts:
 *   - beat grid + BPM (multiband onset detection -> autocorrelation tempo ->
 *     phase-fitted grid) plus raw onset times
 *   - loudness: K-weighted integrated loudness (BS.1770-style blocks with
 *     absolute/relative gating — labeled approximate), peak dBFS, and a
 *     downsampled RMS curve
 *   - silence spans (below a dBFS threshold for a minimum duration)
 *
 * Pure in-app DSP — no ComfyUI, no models. `analyzeAudioBuffer` is exported
 * separately from the URL/file plumbing so tests can feed synthesized
 * AudioBuffers with known BPM/loudness/silence and assert recovery.
 */

const ANALYSIS_CACHE = new Map() // key -> result
const ANALYSIS_CACHE_MAX = 12

let sharedAudioContext = null

function getSharedAudioContext() {
  if (typeof window === 'undefined') return null
  if (sharedAudioContext) return sharedAudioContext
  const Ctor = window.AudioContext || window.webkitAudioContext
  if (!Ctor) return null
  sharedAudioContext = new Ctor()
  return sharedAudioContext
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))
const round3 = (value) => Math.round(value * 1000) / 1000
const round1 = (value) => Math.round(value * 10) / 10

function amplitudeToDb(amplitude) {
  return amplitude > 1e-8 ? 20 * Math.log10(amplitude) : -160
}

// ─────────────────────────────────────────────────────────────────────
// Biquad filters (RBJ cookbook), applied sample-wise on Float32Arrays.
// ─────────────────────────────────────────────────────────────────────

function applyBiquad(input, { b0, b1, b2, a1, a2 }) {
  const output = new Float32Array(input.length)
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < input.length; i += 1) {
    const x0 = input[i]
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
    output[i] = y0
    x2 = x1
    x1 = x0
    y2 = y1
    y1 = y0
  }
  return output
}

function highShelfCoefficients(sampleRate, f0, gainDb, q) {
  const A = 10 ** (gainDb / 40)
  const w0 = (2 * Math.PI * f0) / sampleRate
  const cosW0 = Math.cos(w0)
  const alpha = Math.sin(w0) / (2 * q)
  const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha
  const a0 = (A + 1) - (A - 1) * cosW0 + twoSqrtAAlpha
  return {
    b0: (A * ((A + 1) + (A - 1) * cosW0 + twoSqrtAAlpha)) / a0,
    b1: (-2 * A * ((A - 1) + (A + 1) * cosW0)) / a0,
    b2: (A * ((A + 1) + (A - 1) * cosW0 - twoSqrtAAlpha)) / a0,
    a1: (2 * ((A - 1) - (A + 1) * cosW0)) / a0,
    a2: ((A + 1) - (A - 1) * cosW0 - twoSqrtAAlpha) / a0,
  }
}

function highPassCoefficients(sampleRate, f0, q) {
  const w0 = (2 * Math.PI * f0) / sampleRate
  const cosW0 = Math.cos(w0)
  const alpha = Math.sin(w0) / (2 * q)
  const a0 = 1 + alpha
  return {
    b0: ((1 + cosW0) / 2) / a0,
    b1: (-(1 + cosW0)) / a0,
    b2: ((1 + cosW0) / 2) / a0,
    a1: (-2 * cosW0) / a0,
    a2: (1 - alpha) / a0,
  }
}

function bandPassCoefficients(sampleRate, lowHz, highHz) {
  const f0 = Math.sqrt(lowHz * highHz)
  const q = f0 / Math.max(1, highHz - lowHz)
  const w0 = (2 * Math.PI * f0) / sampleRate
  const alpha = Math.sin(w0) / (2 * q)
  const a0 = 1 + alpha
  // Constant 0 dB peak gain bandpass.
  return {
    b0: alpha / a0,
    b1: 0,
    b2: -alpha / a0,
    a1: (-2 * Math.cos(w0)) / a0,
    a2: (1 - alpha) / a0,
  }
}

// ─────────────────────────────────────────────────────────────────────
// Loudness
// ─────────────────────────────────────────────────────────────────────

// BS.1770 K-weighting: high shelf (+~4dB @ ~1681.97 Hz) then high pass
// (~38.14 Hz). The spec pins exact coefficients at 48 kHz; RBJ-derived
// coefficients at the file's native rate track it closely — hence
// "approximate" LUFS.
function kWeightChannel(samples, sampleRate) {
  const shelved = applyBiquad(samples, highShelfCoefficients(sampleRate, 1681.97, 3.99958, 0.7071752))
  return applyBiquad(shelved, highPassCoefficients(sampleRate, 38.1354, 0.5003270))
}

function computeIntegratedLoudness(channels, sampleRate) {
  const blockSize = Math.round(0.4 * sampleRate)
  const hopSize = Math.round(0.1 * sampleRate) // 75% overlap
  const length = channels[0]?.length || 0
  if (length < blockSize) return null

  const weighted = channels.map((channel) => kWeightChannel(channel, sampleRate))

  const blockLoudness = []
  const blockMeanSquares = []
  for (let start = 0; start + blockSize <= length; start += hopSize) {
    let sum = 0
    for (const channel of weighted) {
      for (let i = start; i < start + blockSize; i += 1) {
        sum += channel[i] * channel[i]
      }
    }
    const meanSquare = sum / blockSize
    blockMeanSquares.push(meanSquare)
    blockLoudness.push(-0.691 + 10 * Math.log10(Math.max(meanSquare, 1e-12)))
  }
  if (blockLoudness.length === 0) return null

  // Absolute gate at -70 LUFS.
  const absoluteGated = blockMeanSquares.filter((_, i) => blockLoudness[i] > -70)
  if (absoluteGated.length === 0) return null
  const absoluteMean = absoluteGated.reduce((sum, ms) => sum + ms, 0) / absoluteGated.length
  const relativeThreshold = (-0.691 + 10 * Math.log10(absoluteMean)) - 10

  // Relative gate at -10 LU below the absolute-gated mean.
  const relativeGated = blockMeanSquares.filter((_, i) => blockLoudness[i] > -70 && blockLoudness[i] > relativeThreshold)
  if (relativeGated.length === 0) return null
  const relativeMean = relativeGated.reduce((sum, ms) => sum + ms, 0) / relativeGated.length
  return -0.691 + 10 * Math.log10(relativeMean)
}

// ─────────────────────────────────────────────────────────────────────
// RMS curve + silence
// ─────────────────────────────────────────────────────────────────────

function computeRmsSeries(mono, sampleRate, hopSeconds = 0.05) {
  const hop = Math.max(64, Math.round(hopSeconds * sampleRate))
  const values = []
  for (let start = 0; start < mono.length; start += hop) {
    const end = Math.min(mono.length, start + hop)
    let sum = 0
    for (let i = start; i < end; i += 1) sum += mono[i] * mono[i]
    values.push(Math.sqrt(sum / Math.max(1, end - start)))
  }
  return { values, hopSeconds: hop / sampleRate }
}

function findSilenceSpans(rmsSeries, { thresholdDb = -45, minSeconds = 0.35 } = {}) {
  const { values, hopSeconds } = rmsSeries
  const spans = []
  let spanStart = null
  for (let i = 0; i <= values.length; i += 1) {
    const silent = i < values.length && amplitudeToDb(values[i]) < thresholdDb
    if (silent && spanStart === null) {
      spanStart = i * hopSeconds
    } else if (!silent && spanStart !== null) {
      const end = i * hopSeconds
      if (end - spanStart >= minSeconds) {
        spans.push({ start: round3(spanStart), end: round3(end), duration: round3(end - spanStart) })
      }
      spanStart = null
    }
  }
  return spans
}

function downsampleRmsCurve(rmsSeries, maxPoints = 400) {
  const { values, hopSeconds } = rmsSeries
  const bucketCount = Math.min(maxPoints, values.length)
  if (bucketCount === 0) return []
  const bucketSize = values.length / bucketCount
  const points = []
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = Math.floor(bucket * bucketSize)
    const end = Math.max(start + 1, Math.floor((bucket + 1) * bucketSize))
    let sum = 0
    for (let i = start; i < end; i += 1) sum += values[i] * values[i]
    const rms = Math.sqrt(sum / (end - start))
    points.push({
      time: round3(((start + end) / 2) * hopSeconds),
      db: round1(amplitudeToDb(rms)),
    })
  }
  return points
}

// ─────────────────────────────────────────────────────────────────────
// Onsets + tempo + beat grid
// ─────────────────────────────────────────────────────────────────────

const ONSET_BANDS = [
  { low: 25, high: 160, weight: 2 },   // kick / bass — carries most beat info
  { low: 160, high: 2000, weight: 1 }, // body
  { low: 2000, high: 9000, weight: 1 }, // hats / transients
]
const ONSET_HOP_SECONDS = 512 / 44100 // ~11.6ms reference hop, scaled per file

function computeOnsetEnvelope(mono, sampleRate) {
  const hop = Math.max(128, Math.round(ONSET_HOP_SECONDS * sampleRate))
  const hopCount = Math.floor(mono.length / hop)
  if (hopCount < 8) return { envelope: new Float32Array(0), hopSeconds: hop / sampleRate }

  const envelope = new Float32Array(hopCount)
  for (const band of ONSET_BANDS) {
    const high = Math.min(band.high, sampleRate / 2 - 100)
    if (high <= band.low) continue
    const filtered = applyBiquad(mono, bandPassCoefficients(sampleRate, band.low, high))

    // Per-hop energy, then positive flux normalized by a running mean so
    // loud and quiet sections contribute comparably.
    const energies = new Float32Array(hopCount)
    for (let h = 0; h < hopCount; h += 1) {
      let sum = 0
      const start = h * hop
      for (let i = start; i < start + hop; i += 1) sum += filtered[i] * filtered[i]
      energies[h] = sum / hop
    }
    let runningMean = energies[0] || 1e-9
    for (let h = 1; h < hopCount; h += 1) {
      runningMean = 0.995 * runningMean + 0.005 * energies[h]
      const flux = Math.max(0, energies[h] - energies[h - 1])
      envelope[h] += band.weight * (flux / Math.max(runningMean, 1e-9))
    }
  }

  // Light 3-tap smoothing.
  const smoothed = new Float32Array(hopCount)
  for (let h = 0; h < hopCount; h += 1) {
    smoothed[h] = (envelope[Math.max(0, h - 1)] + envelope[h] + envelope[Math.min(hopCount - 1, h + 1)]) / 3
  }
  return { envelope: smoothed, hopSeconds: hop / sampleRate }
}

function pickOnsets(envelope, hopSeconds, { minGapSeconds = 0.1 } = {}) {
  const window = 8
  const minGapHops = Math.max(1, Math.round(minGapSeconds / hopSeconds))
  const onsets = []
  let lastOnsetHop = -minGapHops
  for (let h = 1; h < envelope.length - 1; h += 1) {
    if (envelope[h] <= envelope[h - 1] || envelope[h] < envelope[h + 1]) continue
    let sum = 0
    let count = 0
    for (let k = Math.max(0, h - window); k <= Math.min(envelope.length - 1, h + window); k += 1) {
      sum += envelope[k]
      count += 1
    }
    const localMean = sum / Math.max(1, count)
    if (envelope[h] > localMean * 1.5 + 0.02 && h - lastOnsetHop >= minGapHops) {
      onsets.push(h * hopSeconds)
      lastOnsetHop = h
    }
  }
  return onsets
}

function estimateTempo(envelope, hopSeconds) {
  const minBpm = 60
  const maxBpm = 200
  const minLag = Math.max(2, Math.floor(60 / (maxBpm * hopSeconds)))
  const maxLag = Math.min(envelope.length - 2, Math.ceil(60 / (minBpm * hopSeconds)))
  if (maxLag <= minLag) return null

  let mean = 0
  for (let i = 0; i < envelope.length; i += 1) mean += envelope[i]
  mean /= envelope.length
  const centered = new Float32Array(envelope.length)
  for (let i = 0; i < envelope.length; i += 1) centered[i] = envelope[i] - mean

  let zeroLag = 0
  for (let i = 0; i < centered.length; i += 1) zeroLag += centered[i] * centered[i]
  if (zeroLag <= 1e-9) return null

  const autocorr = (lag) => {
    let sum = 0
    for (let i = 0; i + lag < centered.length; i += 1) sum += centered[i] * centered[i + lag]
    return sum / zeroLag
  }

  let bestLag = minLag
  let bestScore = -Infinity
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    // Harmonic reinforcement: a true beat period also correlates at 2x.
    const score = autocorr(lag) + 0.5 * (2 * lag <= envelope.length - 2 ? autocorr(2 * lag) : 0)
    if (score > bestScore) {
      bestScore = score
      bestLag = lag
    }
  }
  if (bestScore <= 0.02) return null

  // Parabolic refinement around the winning lag.
  const y0 = autocorr(Math.max(minLag, bestLag - 1))
  const y1 = autocorr(bestLag)
  const y2 = autocorr(Math.min(maxLag, bestLag + 1))
  const denom = y0 - 2 * y1 + y2
  const offset = Math.abs(denom) > 1e-9 ? clamp((0.5 * (y0 - y2)) / denom, -0.5, 0.5) : 0
  const refinedLag = bestLag + offset

  const periodSeconds = refinedLag * hopSeconds
  return {
    bpm: 60 / periodSeconds,
    periodSeconds,
    confidence: clamp(autocorr(bestLag), 0, 1),
  }
}

function fitBeatGrid(envelope, hopSeconds, periodSeconds, durationSeconds) {
  const periodHops = periodSeconds / hopSeconds
  let bestPhaseHop = 0
  let bestSum = -Infinity
  const phaseSteps = Math.max(4, Math.floor(periodHops))
  for (let step = 0; step < phaseSteps; step += 1) {
    const phase = (step / phaseSteps) * periodHops
    let sum = 0
    for (let position = phase; position < envelope.length; position += periodHops) {
      sum += envelope[Math.round(position)] || 0
    }
    if (sum > bestSum) {
      bestSum = sum
      bestPhaseHop = phase
    }
  }

  const beats = []
  for (let t = bestPhaseHop * hopSeconds; t <= durationSeconds; t += periodSeconds) {
    beats.push(round3(t))
  }
  return beats
}

// ─────────────────────────────────────────────────────────────────────
// Buffer-level analysis (exported for tests)
// ─────────────────────────────────────────────────────────────────────

/**
 * Analyze a decoded AudioBuffer. Options:
 *   startSeconds/endSeconds — restrict to a subrange (clip trim window)
 *   includeLoudnessCurve, maxCurvePoints, silenceThresholdDb, minSilenceSeconds
 * Returned times are relative to the analyzed range's start.
 */
export function analyzeAudioBuffer(audioBuffer, options = {}) {
  const sampleRate = audioBuffer.sampleRate
  const startSample = clamp(Math.floor((Number(options.startSeconds) || 0) * sampleRate), 0, audioBuffer.length)
  const endSample = clamp(
    Number.isFinite(Number(options.endSeconds)) ? Math.floor(Number(options.endSeconds) * sampleRate) : audioBuffer.length,
    startSample,
    audioBuffer.length
  )
  const length = endSample - startSample
  if (length < sampleRate * 0.25) {
    return { duration: round3(length / sampleRate), error: 'Audio range is too short to analyze (under 0.25s).' }
  }

  const channelCount = Math.max(1, Math.min(2, audioBuffer.numberOfChannels || 1))
  const channels = []
  for (let c = 0; c < channelCount; c += 1) {
    channels.push(audioBuffer.getChannelData(c).subarray(startSample, endSample))
  }
  const mono = new Float32Array(length)
  for (let i = 0; i < length; i += 1) {
    let sum = 0
    for (const channel of channels) sum += channel[i]
    mono[i] = sum / channelCount
  }

  const durationSeconds = length / sampleRate

  // Loudness
  let peak = 0
  let sumSquares = 0
  for (let i = 0; i < length; i += 1) {
    const amplitude = Math.abs(mono[i])
    if (amplitude > peak) peak = amplitude
    sumSquares += mono[i] * mono[i]
  }
  const integratedLufs = computeIntegratedLoudness(channels, sampleRate)

  const rmsSeries = computeRmsSeries(mono, sampleRate)
  const silences = findSilenceSpans(rmsSeries, {
    thresholdDb: Number.isFinite(Number(options.silenceThresholdDb)) ? Number(options.silenceThresholdDb) : -45,
    minSeconds: Number.isFinite(Number(options.minSilenceSeconds)) ? Number(options.minSilenceSeconds) : 0.35,
  })

  // Beats
  const { envelope, hopSeconds } = computeOnsetEnvelope(mono, sampleRate)
  const onsets = envelope.length > 0 ? pickOnsets(envelope, hopSeconds) : []
  let bpm = null
  let beatConfidence = 0
  let beats = []
  if (envelope.length > 0 && onsets.length >= 8 && durationSeconds >= 4) {
    const tempo = estimateTempo(envelope, hopSeconds)
    if (tempo) {
      bpm = Math.round(tempo.bpm * 10) / 10
      beatConfidence = Math.round(tempo.confidence * 100) / 100
      beats = fitBeatGrid(envelope, hopSeconds, tempo.periodSeconds, durationSeconds)
    }
  }

  const result = {
    duration: round3(durationSeconds),
    sampleRate,
    channels: audioBuffer.numberOfChannels,
    loudness: {
      peakDb: round1(amplitudeToDb(peak)),
      rmsDb: round1(amplitudeToDb(Math.sqrt(sumSquares / length))),
      integratedLufsApprox: integratedLufs !== null ? round1(integratedLufs) : null,
    },
    bpm,
    beatConfidence,
    beats: beats.slice(0, 1600),
    beatsTruncated: beats.length > 1600,
    onsets: onsets.slice(0, 800).map(round3),
    onsetsTruncated: onsets.length > 800,
    silences,
  }
  if (options.includeLoudnessCurve !== false) {
    result.loudnessCurve = downsampleRmsCurve(rmsSeries, clamp(Math.round(Number(options.maxCurvePoints) || 400), 20, 1000))
  }
  return result
}

// ─────────────────────────────────────────────────────────────────────
// Source decoding + cached entry point
// ─────────────────────────────────────────────────────────────────────

async function fetchSourceBytes({ url, absolutePath }) {
  const isElectronRuntime = typeof window !== 'undefined' && window.electronAPI?.isElectron === true
  if (isElectronRuntime && absolutePath && typeof window.electronAPI.readFileAsBuffer === 'function') {
    const result = await window.electronAPI.readFileAsBuffer(absolutePath)
    if (result?.success && result.data) return result.data
    // Fall through to URL fetch if direct file read failed.
  }
  if (!url) throw new Error('No readable source for audio analysis (missing URL and file path).')
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Could not load audio source (${response.status}).`)
  return response.arrayBuffer()
}

/**
 * Decode + analyze an audio (or video-with-audio) source. Results are cached
 * by source + range + options that change the output.
 */
export async function analyzeAudioSource({ url = '', absolutePath = '' }, options = {}) {
  const cacheKey = [
    absolutePath || url,
    options.startSeconds ?? '',
    options.endSeconds ?? '',
    options.silenceThresholdDb ?? '',
    options.minSilenceSeconds ?? '',
    options.includeLoudnessCurve !== false ? (options.maxCurvePoints || 400) : 'nocurve',
  ].join('|')
  if (ANALYSIS_CACHE.has(cacheKey)) return ANALYSIS_CACHE.get(cacheKey)

  const context = getSharedAudioContext()
  if (!context) throw new Error('Web Audio API is not available.')

  const bytes = await fetchSourceBytes({ url, absolutePath })
  let audioBuffer
  try {
    audioBuffer = await context.decodeAudioData(bytes.slice(0))
  } catch (err) {
    throw new Error('Could not decode audio from this source (unsupported codec or no audio track).')
  }

  const result = analyzeAudioBuffer(audioBuffer, options)
  ANALYSIS_CACHE.set(cacheKey, result)
  if (ANALYSIS_CACHE.size > ANALYSIS_CACHE_MAX) {
    const first = ANALYSIS_CACHE.keys().next().value
    if (first) ANALYSIS_CACHE.delete(first)
  }
  return result
}
