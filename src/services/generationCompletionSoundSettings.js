const GENERATION_COMPLETION_SOUND_STORAGE_KEY = 'comfystudio-generation-completion-sound'
let generationCompletionAudioContext = null

export const GENERATION_COMPLETION_SOUND_CHANGED_EVENT = 'comfystudio-generation-completion-sound-changed'

export const GENERATION_COMPLETION_SOUND_OPTIONS = Object.freeze([
  {
    id: 'soft-chime',
    label: 'Soft chime',
    description: 'A gentle three-note finish sound.',
    oscillatorType: 'sine',
    frequencies: [523.25, 659.25, 783.99],
    spacingSeconds: 0.11,
    toneSeconds: 0.22,
    tailSeconds: 0.62,
    gain: 1,
  },
  {
    id: 'clean-ding',
    label: 'Clean ding',
    description: 'A brighter two-note alert.',
    oscillatorType: 'triangle',
    frequencies: [880, 1174.66],
    spacingSeconds: 0.09,
    toneSeconds: 0.26,
    tailSeconds: 0.52,
    gain: 1,
  },
  {
    id: 'subtle-beep',
    label: 'Subtle beep',
    description: 'A short, minimal notification.',
    oscillatorType: 'sine',
    frequencies: [659.25],
    spacingSeconds: 0,
    toneSeconds: 0.2,
    tailSeconds: 0.32,
    gain: 1,
  },
])

export const DEFAULT_GENERATION_COMPLETION_SOUND_SETTINGS = Object.freeze({
  enabled: true,
  volume: 5,
  soundId: 'soft-chime',
})

export function getGenerationCompletionSoundOption(soundId) {
  return GENERATION_COMPLETION_SOUND_OPTIONS.find((option) => option.id === soundId)
    || GENERATION_COMPLETION_SOUND_OPTIONS[0]
}

export function normalizeGenerationCompletionSoundSettings(value = {}) {
  const soundId = String(value?.soundId || DEFAULT_GENERATION_COMPLETION_SOUND_SETTINGS.soundId)
  const option = getGenerationCompletionSoundOption(soundId)
  const rawVolume = Number(value?.volume)
  return {
    enabled: typeof value?.enabled === 'boolean'
      ? value.enabled
      : DEFAULT_GENERATION_COMPLETION_SOUND_SETTINGS.enabled,
    volume: Number.isFinite(rawVolume)
      ? Math.max(0, Math.min(10, Math.round(rawVolume)))
      : DEFAULT_GENERATION_COMPLETION_SOUND_SETTINGS.volume,
    soundId: option.id,
  }
}

export function getGenerationCompletionSoundSettings() {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_GENERATION_COMPLETION_SOUND_SETTINGS }
  try {
    const raw = localStorage.getItem(GENERATION_COMPLETION_SOUND_STORAGE_KEY)
    if (!raw) return { ...DEFAULT_GENERATION_COMPLETION_SOUND_SETTINGS }
    return normalizeGenerationCompletionSoundSettings(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_GENERATION_COMPLETION_SOUND_SETTINGS }
  }
}

export function setGenerationCompletionSoundSettings(nextSettings) {
  const normalized = normalizeGenerationCompletionSoundSettings(nextSettings)
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(GENERATION_COMPLETION_SOUND_STORAGE_KEY, JSON.stringify(normalized))
    } catch (_) {}
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(GENERATION_COMPLETION_SOUND_CHANGED_EVENT, {
      detail: normalized,
    }))
  }
  return normalized
}

export function playGenerationCompletionSound(settings = getGenerationCompletionSoundSettings()) {
  const normalizedSettings = normalizeGenerationCompletionSoundSettings(settings)
  const normalizedVolume = Math.max(0, Math.min(10, Number(normalizedSettings.volume) || 0))
  if (!normalizedSettings.enabled || normalizedVolume <= 0) return
  if (typeof window === 'undefined') return

  const AudioContextCtor = window.AudioContext || window.webkitAudioContext
  if (!AudioContextCtor) return

  const soundOption = getGenerationCompletionSoundOption(normalizedSettings.soundId)

  try {
    const context = generationCompletionAudioContext && generationCompletionAudioContext.state !== 'closed'
      ? generationCompletionAudioContext
      : new AudioContextCtor()
    generationCompletionAudioContext = context

    const play = () => {
      const masterGain = context.createGain()
      const startAt = context.currentTime + 0.02
      const outputGain = Math.min(1, soundOption.gain * (normalizedVolume / 10))
      masterGain.gain.setValueAtTime(0.0001, startAt)
      masterGain.gain.exponentialRampToValueAtTime(outputGain, startAt + 0.035)
      masterGain.gain.exponentialRampToValueAtTime(0.0001, startAt + soundOption.tailSeconds)
      masterGain.connect(context.destination)

      soundOption.frequencies.forEach((frequency, index) => {
        const oscillator = context.createOscillator()
        const toneGain = context.createGain()
        const toneStart = startAt + (index * soundOption.spacingSeconds)
        const toneEnd = toneStart + soundOption.toneSeconds
        oscillator.type = soundOption.oscillatorType
        oscillator.frequency.setValueAtTime(frequency, toneStart)
        toneGain.gain.setValueAtTime(0.0001, toneStart)
        toneGain.gain.exponentialRampToValueAtTime(1, toneStart + 0.025)
        toneGain.gain.exponentialRampToValueAtTime(0.0001, toneEnd)
        oscillator.connect(toneGain)
        toneGain.connect(masterGain)
        oscillator.start(toneStart)
        oscillator.stop(toneEnd + 0.02)
      })
    }

    if (context.state === 'suspended') {
      context.resume().then(play).catch(() => {})
      return
    }
    play()
  } catch (error) {
    console.warn('Failed to play generation completion sound:', error)
  }
}
