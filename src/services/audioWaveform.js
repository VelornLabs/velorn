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
  // Per-channel peaks (up to stereo), true levels — no per-file
  // normalization, matching the main-process ffmpeg extraction.
  const channelCount = Math.max(1, Math.min(2, audioBuffer.numberOfChannels || 1))
  const totalSamples = Math.max(1, audioBuffer.length || 1)
  const buckets = Math.max(32, sampleCount)
  const bucketSize = Math.max(1, Math.floor(totalSamples / buckets))
  const channelPeaks = []

  for (let channel = 0; channel < channelCount; channel += 1) {
    const channelData = audioBuffer.getChannelData(channel)
    const peaksForChannel = new Array(buckets).fill(0)
    for (let index = 0; index < buckets; index += 1) {
      const start = index * bucketSize
      const end = index === buckets - 1 ? totalSamples : Math.min(totalSamples, start + bucketSize)
      let peak = 0
      for (let sample = start; sample < end; sample += 1) {
        const amplitude = Math.abs(channelData[sample] || 0)
        if (amplitude > peak) peak = amplitude
      }
      peaksForChannel[index] = Math.min(1, peak)
    }
    channelPeaks.push(peaksForChannel)
  }

  const peaks = channelPeaks.length > 1
    ? channelPeaks[0].map((value, index) => Math.max(value, channelPeaks[1][index]))
    : channelPeaks[0]

  return {
    peaks,
    channelPeaks: channelPeaks.length > 1 ? channelPeaks : null,
  }
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
          channelPeaks: Array.isArray(result.channelPeaks) && result.channelPeaks.length >= 2
            ? result.channelPeaks
            : null,
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
    const built = buildWaveformPeaks(audioBuffer, sampleCount)
    return {
      ...built,
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
