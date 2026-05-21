let audioWaveformContext = null

const AUDIO_WAVEFORM_CACHE = new Map()
const AUDIO_WAVEFORM_PENDING = new Map()
const DEFAULT_AUDIO_WAVEFORM_SAMPLES = 8192

function getAudioWaveformContext() {
  if (typeof window === 'undefined') return null
  if (audioWaveformContext) return audioWaveformContext
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext
  if (!AudioContextCtor) return null
  audioWaveformContext = new AudioContextCtor()
  return audioWaveformContext
}

function buildWaveformPeaks(audioBuffer, sampleCount = DEFAULT_AUDIO_WAVEFORM_SAMPLES) {
  const channelCount = Math.max(1, audioBuffer.numberOfChannels || 1)
  const totalSamples = Math.max(1, audioBuffer.length || 1)
  const buckets = Math.max(32, sampleCount)
  const bucketSize = Math.max(1, Math.floor(totalSamples / buckets))
  const peaks = new Float32Array(buckets)

  for (let index = 0; index < buckets; index += 1) {
    const start = index * bucketSize
    const end = index === buckets - 1 ? totalSamples : Math.min(totalSamples, start + bucketSize)
    const span = Math.max(1, end - start)
    const stride = Math.max(1, Math.floor(span / 64))
    let peak = 0

    for (let channel = 0; channel < channelCount; channel += 1) {
      const channelData = audioBuffer.getChannelData(channel)
      for (let sample = start; sample < end; sample += stride) {
        const amplitude = Math.abs(channelData[sample] || 0)
        if (amplitude > peak) peak = amplitude
      }
    }

    peaks[index] = peak
  }

  let maxPeak = 0
  for (let index = 0; index < peaks.length; index += 1) {
    if (peaks[index] > maxPeak) maxPeak = peaks[index]
  }
  if (maxPeak > 0) {
    for (let index = 0; index < peaks.length; index += 1) {
      peaks[index] = peaks[index] / maxPeak
    }
  }

  return peaks
}

function isNativeMediaUrl(url) {
  return /^file:\/\//i.test(url) || /^comfystudio:\/\//i.test(url)
}

function isAbsoluteMediaPath(value) {
  return /^[a-zA-Z]:[\\/]/.test(String(value || '')) || String(value || '').startsWith('/')
}

export async function getAudioWaveformData(url, sampleCount = DEFAULT_AUDIO_WAVEFORM_SAMPLES) {
  if (!url) return null
  const key = `${url}|${sampleCount}`
  if (AUDIO_WAVEFORM_CACHE.has(key)) return AUDIO_WAVEFORM_CACHE.get(key)
  if (AUDIO_WAVEFORM_PENDING.has(key)) return AUDIO_WAVEFORM_PENDING.get(key)

  const loadPromise = (async () => {
    const isElectronRuntime = typeof window !== 'undefined' && window.electronAPI?.isElectron === true

    if (
      isElectronRuntime
      && typeof window.electronAPI?.getAudioWaveform === 'function'
      && (isNativeMediaUrl(url) || isAbsoluteMediaPath(url))
    ) {
      const result = await window.electronAPI.getAudioWaveform(url, { sampleCount })
      if (result?.success && Array.isArray(result.peaks)) {
        return {
          peaks: result.peaks,
          duration: Number(result.duration) || 0,
        }
      }
      throw new Error(result?.error || 'Failed to extract waveform in main process')
    }

    const isBlobOrDataUrl = /^blob:/i.test(url) || /^data:/i.test(url)
    if (isElectronRuntime && !isBlobOrDataUrl) {
      return null
    }

    const context = getAudioWaveformContext()
    if (!context) throw new Error('Web Audio API is not available')
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Failed to load audio: ${response.status}`)
    const arrayBuffer = await response.arrayBuffer()
    const audioBuffer = await context.decodeAudioData(arrayBuffer.slice(0))
    const peaks = buildWaveformPeaks(audioBuffer, sampleCount)
    return {
      peaks,
      duration: audioBuffer.duration || 0,
    }
  })()
    .then((result) => {
      AUDIO_WAVEFORM_PENDING.delete(key)
      if (result) AUDIO_WAVEFORM_CACHE.set(key, result)
      return result
    })
    .catch((error) => {
      AUDIO_WAVEFORM_PENDING.delete(key)
      throw error
    })

  AUDIO_WAVEFORM_PENDING.set(key, loadPromise)
  return loadPromise
}
