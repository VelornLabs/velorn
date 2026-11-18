// Pure decisions for the Create tab: what the button says, what a price looks
// like, and which screen a Comfy answer leads to. No React, no window, no IPC,
// so it can be tested directly.

export const SHAPES = [
  { id: 'landscape', label: 'Wide', w: 22, h: 14 },
  { id: 'square', label: 'Square', w: 16, h: 16 },
  { id: 'portrait', label: 'Tall', w: 13, h: 20 },
]
export const SIZE_LABELS = { '1K': 'Standard · 1K', '2K': 'Large · 2K', '4K': 'Largest · 4K' }
export const SIZE_NAMES = { '1K': 'Standard', '2K': 'Large', '4K': 'Largest' }
export const RESOLUTION_LABELS = { '720p': 'Standard · 720p', '1080p': 'High · 1080p' }
export const PICTURE_TYPES = ['image/png', 'image/jpeg', 'image/webp']
export const PICTURE_MAX_BYTES = 10 * 1024 * 1024
export const DEFAULT_OPTIONS = { shape: 'landscape', size: '1K', seconds: 5, resolution: '720p' }
// What Create can make, in the order the box offers them.
export const KIND_ORDER = ['image', 'video', 'voice', 'sound', 'music']
export const AUDIO_KINDS = ['voice', 'sound', 'music']
// Music is made on this computer by the same two models as the timeline's
// Music button. Comfy has no working cloud music model (2026-11-09), so these
// are not in the main-process list: nothing about them is sent or charged.
export const LOCAL_MUSIC = Object.freeze([
  Object.freeze({ id: 'local-yue2', kind: 'music', local: true, backend: 'yue2', workflowId: 'music-gen-yue2', name: 'YuE2', default: true,
    about: 'It makes songs on your own computer.',
    note: 'Runs on this computer. Stops by itself, up to the length you pick.', seconds: Object.freeze({ offered: Object.freeze([30, 60, 120, 180]) }) }),
  Object.freeze({ id: 'local-ace-step', kind: 'music', local: true, backend: 'ace-step', workflowId: 'music-gen', name: 'ACE-Step',
    about: 'It makes music on your own computer, at exactly the length you ask for.',
    note: 'Runs on this computer. Exactly the length you pick.', seconds: Object.freeze({ offered: Object.freeze([30, 60, 120, 180]) }) }),
])
// Local sound effects: Stable Audio 3.0, run as a plain ComfyUI workflow. Its two
// files (about 10 GB) are downloaded on request by the Sound tab's setup panel.
export const LOCAL_SOUND = Object.freeze([
  Object.freeze({ id: 'local-stable-audio-3', kind: 'sound', local: true, via: 'workflow', workflowId: 'sound-stable-audio-3', name: 'Stable Audio 3.0', default: true,
    note: 'Runs on this computer. Effects and short sounds.', about: 'It makes sound effects and short sounds on your own computer.',
    // Shown in the download panel before anything is downloaded. See docs/CREATE_SOUND_LICENCES.md.
    terms: Object.freeze({ text: 'Stable Audio 3.0 is under the Stability AI Community License: free for personal use and for businesses earning under $1M a year. Its text reader is under Google’s Gemma terms.',
      links: Object.freeze([Object.freeze({ label: 'Stability licence', url: 'https://stability.ai/license' }), Object.freeze({ label: 'Gemma terms', url: 'https://ai.google.dev/gemma/terms' })]) }),
    seconds: Object.freeze({ offered: Object.freeze([3, 5, 10, 20]) }) }),
])
// The ComfyUI prompt for one Stable Audio 3.0 sound. Node '8' saves the audio.
export function stableAudioWorkflow({ prompt, seconds, seed }) {
  if (!prompt.trim()) throw new Error('Write a description first.')
  if (!(seconds >= 1 && seconds <= 190)) throw new Error('Stable Audio makes 1 second to about 3 minutes.')
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('Bad seed.')
  return {
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'stable_audio_3_medium.safetensors' } },
    2: { class_type: 'CLIPLoader', inputs: { clip_name: 't5gemma_b_b_ul2.safetensors', type: 'stable_audio', device: 'default' } },
    3: { class_type: 'CLIPTextEncode', inputs: { text: prompt.trim(), clip: ['2', 0] } },
    4: { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['2', 0] } },
    5: { class_type: 'EmptyLatentAudio', inputs: { seconds, batch_size: 1 } },
    6: { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['3', 0], negative: ['4', 0], latent_image: ['5', 0], seed, steps: 8, cfg: 1, sampler_name: 'lcm', scheduler: 'simple', denoise: 1 } },
    7: { class_type: 'VAEDecodeAudio', inputs: { samples: ['6', 0], vae: ['1', 2] } },
    8: { class_type: 'SaveAudioMP3', inputs: { audio: ['7', 0], filename_prefix: 'audio/velorn_stable_audio', quality: 'V0' } },
  }
}
export const LOCAL_PRICE = 'free, made on this computer'
// Local voices: Kokoro 82M (Apache-2.0), which runs inside Velorn itself. No ComfyUI
// and no graphics card; its files (about 120 MB) are downloaded on request and kept
// in Velorn's data folder. The ids are the model's own voice names.
export const LOCAL_VOICE = Object.freeze([
  Object.freeze({ id: 'local-kokoro', kind: 'voice', local: true, via: 'builtin', name: 'Kokoro', default: true,
    note: 'Runs on this computer, inside Velorn. No ComfyUI needed.', about: 'It turns text into speech on your own computer, with no ComfyUI and no graphics card.',
    characters: Object.freeze({ max: 3000 }), voices: Object.freeze([
    { id: 'af_heart', name: 'Heart', note: 'American, female' },
    { id: 'af_bella', name: 'Bella', note: 'American, female' },
    { id: 'af_nicole', name: 'Nicole', note: 'American, female, soft' },
    { id: 'af_sarah', name: 'Sarah', note: 'American, female' },
    { id: 'am_michael', name: 'Michael', note: 'American, male' },
    { id: 'am_fenrir', name: 'Fenrir', note: 'American, male' },
    { id: 'am_puck', name: 'Puck', note: 'American, male' },
    { id: 'bf_emma', name: 'Emma', note: 'British, female' },
    { id: 'bm_george', name: 'George', note: 'British, male' },
    { id: 'bm_fable', name: 'Fable', note: 'British, male' },
    ]) }),
])
// Cloud models that only exist as paid nodes inside ComfyUI. ComfyUI makes the
// call with the person's Comfy account, so it has to be running, and Velorn's
// spending check asks before each one. Prices are the nodes' own (2026-11-09):
// 0.5275 credits a second for a description, $0.0032175 a second for a sung song.
// Voices as each ComfyUI node names them (read from a running ComfyUI, 2026-11-09). The id is the exact option the node takes.
const FISH_VOICES = Object.freeze([
    { id: 'Energetic Male (en)', name: 'Energetic Male', note: 'English' },
    { id: 'Friendly Women (en)', name: 'Friendly Women', note: 'English' },
    { id: 'Sarah (en)', name: 'Sarah', note: 'English' },
    { id: 'Verity (en)', name: 'Verity', note: 'English' },
    { id: 'Polo (en)', name: 'Polo', note: 'English' },
    { id: 'Adrian (en)', name: 'Adrian', note: 'English' },
    { id: 'E-girl (en)', name: 'E-girl', note: 'English' },
    { id: 'Narrator (en)', name: 'Narrator', note: 'English' },
    { id: 'Warm Conversational Voice (en)', name: 'Warm Conversational Voice', note: 'English' },
    { id: 'Warm Storyteller (en)', name: 'Warm Storyteller', note: 'English' },
    { id: 'Dramatic Character Male (en)', name: 'Dramatic Character Male', note: 'English' },
    { id: 'Delia (en)', name: 'Delia', note: 'English' },
    { id: 'Sheila (en)', name: 'Sheila', note: 'English' },
])
const HEYGEN_VOICES = Object.freeze([
    { id: 'Chill Brian (English, male)', name: 'Chill Brian', note: 'English, male' },
    { id: 'Zain (English, female)', name: 'Zain', note: 'English, female' },
    { id: 'Aria (English, female)', name: 'Aria', note: 'English, female' },
    { id: 'Caryns (English, female)', name: 'Caryns', note: 'English, female' },
    { id: 'Klara (English, female)', name: 'Klara', note: 'English, female' },
    { id: 'Shaun (English, male)', name: 'Shaun', note: 'English, male' },
    { id: 'Senthil (English, male)', name: 'Senthil', note: 'English, male' },
    { id: 'Cody (English, male)', name: 'Cody', note: 'English, male' },
    { id: 'Saffron (English, female)', name: 'Saffron', note: 'English, female' },
    { id: 'Rami (English, male)', name: 'Rami', note: 'English, male' },
    { id: 'Rhodes (English, female)', name: 'Rhodes', note: 'English, female' },
    { id: 'Reassuring Rupert (English, male)', name: 'Reassuring Rupert', note: 'English, male' },
    { id: 'Dynamic Derek (English, male)', name: 'Dynamic Derek', note: 'English, male' },
    { id: 'Lotte (English, female)', name: 'Lotte', note: 'English, female' },
    { id: 'Marcia (English, female)', name: 'Marcia', note: 'English, female' },
])
export const COMFY_CLOUD = Object.freeze([
  // Fish Audio is priced on the bytes of text: $21.45 a million (s2.1-pro), $35.75 (drama-3).
  Object.freeze({ id: 'fish-s2-pro', kind: 'voice', via: 'comfyui', name: 'Fish Audio', firmQuote: true, voices: FISH_VOICES,
    note: 'Runs through ComfyUI. Low cost, natural voices.', characters: Object.freeze({ max: 3000 }), usdPer1kCharacters: 0.02145 }),
  Object.freeze({ id: 'fish-drama-3', kind: 'voice', via: 'comfyui', name: 'Fish Audio Drama 3', firmQuote: true, voices: FISH_VOICES,
    note: 'Runs through ComfyUI. Acted delivery: add directions like [calm] or [excited].', characters: Object.freeze({ max: 3000 }), usdPer1kCharacters: 0.03575 }),
  // HeyGen is priced on the length of the recording ($0.00095 a second), so the figure from text is an estimate.
  Object.freeze({ id: 'heygen-tts', kind: 'voice', via: 'comfyui', name: 'HeyGen', firmQuote: false, voices: HEYGEN_VOICES,
    note: 'Runs through ComfyUI. Presenter-style voices.', characters: Object.freeze({ max: 3000 }), usdPer1kCharacters: 0.064 }),
  Object.freeze({ id: 'sonilo', kind: 'music', via: 'comfyui', name: 'Sonilo', default: true, firmQuote: true,
    note: 'Runs through ComfyUI. Instrumental, or sung from your lyrics.', seconds: Object.freeze({ offered: Object.freeze([30, 60, 120, 180]) }),
    usdPerAudioSecond: 0.0025, usdPerAudioSecondSung: 0.0032175 }),
])
// The ComfyUI prompt for one line of speech on a cloud voice node, and which node saves it.
export function cloudVoiceWorkflow(model, { text, voice, seed }) {
  const words = typeof text === 'string' ? text.trim() : ''
  if (!words) throw new Error('Write what the voice should say first.')
  if (words.length > (model.characters?.max || 3000)) throw new Error(`${model.name} takes up to ${(model.characters?.max || 3000).toLocaleString('en-US')} characters at a time.`)
  if (!(model.voices || []).some(item => item.id === voice)) throw new Error('Choose a voice.')
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 2147483647) throw new Error('Bad seed.')
  if (model.id === 'heygen-tts') return { outputNodeId: '2', workflow: {
    1: { class_type: 'HeyGenTextToSpeechNode', inputs: { text: words, voice, custom_voice_id: '', speed: 1, ssml: false, seed } },
    2: { class_type: 'SaveAudioMP3', inputs: { audio: ['1', 0], filename_prefix: 'audio/velorn_heygen', quality: 'V0' } } } }
  if (model.id === 'fish-s2-pro' || model.id === 'fish-drama-3') return { outputNodeId: '3', workflow: {
    1: { class_type: 'FishAudioVoiceSelector', inputs: { voice } },
    2: { class_type: 'FishAudioTextToSpeech', inputs: { text: words, model: model.id === 'fish-drama-3' ? 'drama-3' : 's2.1-pro', 'model.voices.voice0': ['1', 0],
      'model.temperature': 0.7, 'model.top_p': 0.7, 'model.speed': 1, 'model.volume': 0, 'model.normalize': true, seed } },
    3: { class_type: 'SaveAudioMP3', inputs: { audio: ['2', 0], filename_prefix: 'audio/velorn_fish', quality: 'V0' } } } }
  throw new Error('Unknown cloud voice model.')
}
// Tempo for songs. ACE-Step takes a real number; the other models read it from the description.
export const TEMPOS = Object.freeze([{ id: 'auto', label: 'Any', bpm: null }, { id: 'slow', label: 'Slow', bpm: 75 }, { id: 'medium', label: 'Medium', bpm: 105 }, { id: 'fast', label: 'Fast', bpm: 140 }])
export const tempoBpm = id => TEMPOS.find(item => item.id === id)?.bpm ?? null
export const withTempo = (prompt, bpm) => (bpm ? `${prompt.trim()}, ${bpm} BPM` : prompt.trim())
// Which side of the Sound tab a model belongs to.
export const placeOf = model => (model?.local ? 'local' : 'cloud')
export const SONILO_PROMPT_MAX = 2000
// The ComfyUI prompt for one Sonilo song. With lyrics it is the sung model, and
// the words go in a 'Lyrics:' block as that node asks; without, the instrumental one.
// Node '2' saves the audio.
export function soniloWorkflow({ prompt, seconds, lyrics = '', seed }) {
  const words = typeof lyrics === 'string' ? lyrics.trim() : ''
  const text = words ? `${prompt.trim()}\n\nLyrics:\n${words}` : prompt.trim()
  if (!prompt.trim()) throw new Error('Write a description first.')
  if (text.length > SONILO_PROMPT_MAX) throw new Error(`Sonilo takes up to ${SONILO_PROMPT_MAX.toLocaleString('en-US')} characters, description and lyrics together.`)
  if (!Number.isInteger(seconds) || seconds < 10 || seconds > 360) throw new Error('Sonilo makes 10 seconds to 6 minutes.')
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('Bad seed.')
  return {
    1: words ? { class_type: 'SoniloMusic15', inputs: { prompt: text, duration: 'custom', 'duration.seconds': seconds, seed } }
      : { class_type: 'SoniloTextToMusic', inputs: { prompt: text, duration: seconds, seed } },
    2: { class_type: 'SaveAudioMP3', inputs: { audio: ['1', 0], filename_prefix: 'audio/velorn_sonilo', quality: 'V0' } },
  }
}
// The Sound tab: which kinds it holds, and things to start from.
export const SOUND_KINDS = ['voice', 'music', 'sound']
export const MOODS = Object.freeze([
  { name: 'Lo-fi', prompt: 'lo-fi hip hop, mellow, soft piano, warm bass, vinyl crackle, slow tempo' },
  { name: 'Cinematic', prompt: 'cinematic orchestral, sweeping strings, deep brass, slow build, emotional' },
  { name: 'Upbeat', prompt: 'upbeat pop, bright guitars, claps, energetic drums, feel-good, fast tempo' },
  { name: 'Ambient', prompt: 'ambient, airy pads, gentle textures, no drums, calm and spacious' },
  { name: 'Acoustic', prompt: 'acoustic guitar, light percussion, warm and intimate, medium tempo' },
  { name: 'Electronic', prompt: 'electronic, pulsing synth bass, crisp drums, driving, modern' },
])
export const IDEAS = Object.freeze(['A wooden door creaking open', 'Rain on a window', 'A fast whoosh', 'Footsteps on gravel'])
export const lengthLabel = seconds => (seconds < 60 ? `${seconds} sec` : `${seconds / 60} min`)
// What to ask the local music service for.
export function localMusicRequest(model, prompt, options, lyrics = '', bpm = null) {
  const words = typeof lyrics === 'string' ? lyrics.trim() : ''
  const exact = model.backend === 'ace-step'
  return { backend: model.backend, tags: exact || !bpm ? prompt.trim() : `${prompt.trim()}, ${bpm} bpm`, instrumental: !words, ...(words ? { lyrics: words } : {}), durationSeconds: options.seconds, variations: 1,
    ...(exact && bpm ? { bpm } : {}), ...(model.backend === 'yue2' ? { lengthMode: 'custom' } : {}) }
}
// The local service says what went wrong in its own words; point at where setup lives.
export function localMusicProblem(error) {
  const message = typeof error?.message === 'string' && error.message.trim() ? error.message.trim() : 'The music could not be started. Check that ComfyUI is running.'
  return /not ready|could not check|connect comfyui/i.test(message) ? `${message} You can set it up from the Music button on the timeline.` : message
}
export const isAudioKind = kind => AUDIO_KINDS.includes(kind)
export const PLACEHOLDERS = {
  image: 'Describe the image you have in mind…', video: 'Describe the shot you want to see…',
  voice: 'Write what the voice should say…', sound: 'Describe the sound effect, like a wooden door creaking open…',
  music: 'Describe the music: mood, instruments, tempo…',
}

const EXTENSION_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }
// The picture type of a project asset, from its file name; '' when it is not one Create can send.
export function pictureTypeFor(asset) {
  const name = String(asset?.absolutePath || asset?.path || asset?.name || '')
  const match = /\.([a-z0-9]+)$/i.exec(name)
  return (match && EXTENSION_TYPES[match[1].toLowerCase()]) || ''
}
// Project assets that can be offered as an input picture, newest first.
export function usablePictures(assets) {
  return (assets || []).filter(asset => asset?.type === 'image' && asset.id && asset.url && pictureTypeFor(asset)).slice().reverse()
}

export const money = usd => `$${Number(usd).toFixed(2)}`
// Comfy shows balances and usage in credits. `rate` is credits per dollar, as
// the main process sent it. An estimate is a whole number of credits (never
// zero); an amount Comfy actually charged keeps one decimal when it has one.
const count = (n, digits) => n.toLocaleString('en-US', { maximumFractionDigits: digits })
const usableRate = rate => typeof rate === 'number' && Number.isFinite(rate) && rate > 0
export function creditsText(usd, rate) {
  if (!usableRate(rate) || !Number.isFinite(Number(usd))) return ''
  const n = Math.max(1, Math.round(Number(usd) * rate))
  return `${count(n, 0)} ${n === 1 ? 'credit' : 'credits'}`
}
// What a finished run cost, credits first because that is the figure Comfy reports.
export function chargedText(results) {
  const all = results || []
  if (!all.length || !all.every(item => typeof item.chargedUsd === 'number')) return ''
  const usd = all.reduce((sum, item) => sum + item.chargedUsd, 0)
  if (!all.every(item => typeof item.chargedCredits === 'number')) return `charged ${money(usd)}`
  const credits = Math.round(all.reduce((sum, item) => sum + item.chargedCredits, 0) * 10) / 10
  return `charged ${count(credits, 1)} ${credits === 1 ? 'credit' : 'credits'} (${money(usd)})`
}
// The not-enough-credits sentence.
export function needText(price, rate) {
  if (!price) return "Your Comfy account doesn't have enough credits for this."
  const credits = creditsText(price.usd, rate)
  return `This needs ${credits ? `about ${credits.replace(/ credits?$/, m => ` Comfy${m}`)} (${money(price.usd)})` : `${priceText(price)} in Comfy credits`}, and your account doesn't have enough.`
}

export function defaultModel(models, kind) {
  const ofKind = (models || []).filter(m => m.kind === kind)
  return ofKind.find(m => m.default) || ofKind[0] || null
}

// The choices that are valid for this model, pulling an unsupported size,
// length or resolution back to the nearest thing the model offers.
export function fitOptions(model, options = {}, { voices = [] } = {}) {
  const o = { ...DEFAULT_OPTIONS, ...options }
  const shape = SHAPES.some(s => s.id === o.shape) ? o.shape : 'landscape'
  if (!model) return { shape }
  if (model.kind === 'voice') return { voice: voices.some(v => v.id === options.voice) ? options.voice : voices[0]?.id || '' }
  if (isAudioKind(model.kind)) {
    const offered = model.seconds?.offered || [5]
    return { seconds: offered.includes(options.seconds) ? options.seconds : offered[0] }
  }
  if (model.kind === 'video') {
    const offered = model.seconds?.offered || [5]
    const seconds = offered.includes(o.seconds) ? o.seconds : offered[0]
    const resolution = (model.resolutions || []).includes(o.resolution) ? o.resolution : '720p'
    return { shape, seconds, resolution }
  }
  const sizes = model.sizes || ['1K']
  const wanted = ['1K', '2K', '4K'].indexOf(o.size)
  const size = sizes.includes(o.size) ? o.size : [...sizes].reverse().find(s => ['1K', '2K', '4K'].indexOf(s) <= wanted) || sizes[0]
  return { shape, size }
}

// A note for the options popup when the model could not honour a choice.
export function fitNote(model, wanted = {}) {
  if (!model) return ''
  const fitted = fitOptions(model, wanted)
  if (model.kind === 'image' && wanted.size && wanted.size !== fitted.size) return `${model.name} goes up to ${SIZE_NAMES[fitted.size]}, so this uses ${SIZE_NAMES[fitted.size]}.`
  if (model.kind === 'video' && wanted.resolution && wanted.resolution !== fitted.resolution) return `${model.name} makes 720p only, so this uses 720p.`
  return ''
}

// The recorded price for these choices, from the list the main process sent.
// `firm: false` means "usually about". Returns null when there is no price.
export function recordedPrice(model, options, { hasPicture = false, characters = 0 } = {}) {
  if (!model) return null
  // Speech is priced on how much there is to say; nothing written yet means no price yet.
  if (model.kind === 'voice') return characters > 0 && characters <= (model.characters?.max || 0) && typeof model.usdPer1kCharacters === 'number'
    ? { usd: model.usdPer1kCharacters * characters / 1000, firm: model.firmQuote } : null
  if (isAudioKind(model.kind)) {
    const seconds = fitOptions(model, options).seconds
    return typeof model.usdPerAudioSecond === 'number' ? { usd: model.usdPerAudioSecond * seconds, firm: model.firmQuote } : null
  }
  const o = fitOptions(model, options)
  if (model.kind === 'video') {
    const rate = model.usdPerSecond?.[o.resolution]
    return typeof rate === 'number' ? { usd: rate * o.seconds, firm: model.firmQuote && !hasPicture } : null
  }
  if (hasPicture && model.editQuote === false) return null
  const each = model.usdPerImage?.[o.size]
  return typeof each === 'number' ? { usd: each, firm: model.firmQuote && !hasPicture } : null
}

export function priceText(price, { editing = false, rate = null } = {}) {
  if (!price) return editing ? 'no price before an edit' : 'no firm price yet'
  const credits = creditsText(price.usd, rate)
  // Sounds and short lines of speech can cost a fraction of a cent.
  if (price.usd < 0.005) return `under $0.01${credits ? ` · ${credits}` : ''}`
  return `${price.firm ? 'about' : 'usually about'} ${money(price.usd)}${credits ? ` · ${credits}` : ''}`
}
// What a model costs before there is anything to price: per 1,000 characters of speech.
export function rateText(model, rate = null) {
  if (model?.kind !== 'voice' || typeof model.usdPer1kCharacters !== 'number') return ''
  const credits = creditsText(model.usdPer1kCharacters, rate)
  return `${money(model.usdPer1kCharacters)}${credits ? ` · ${credits}` : ''} per 1,000 characters`
}
export const capital = text => text.charAt(0).toUpperCase() + text.slice(1)

// After Velorn asks Comfy for the real price at click time: may the click that
// showed `shown` stand as approval for `quoted`? A price that rose noticeably,
// or appeared or vanished, needs a fresh look first.
export function sameDeal(shown, quoted) {
  if (!shown || !quoted) return !shown && !quoted
  return quoted.usd <= shown.usd * 1.1 + 0.005
}

export function footnote({ connected, remembered, model, price }) {
  if (model?.network) return 'Made on a computer that shares its GPU with you, free. The description and picture travel through Velorn’s service to that computer, and its owner can see them. Nothing sexually explicit.'
  if (model?.via === 'builtin') return 'Made on this computer, inside Velorn. Nothing is sent anywhere and nothing is charged.'
  if (model?.local) return 'Made on this computer with ComfyUI. Nothing is sent to Comfy and nothing is charged.'
  if (model?.via === 'comfyui') return 'Runs through ComfyUI and uses credits from your Comfy account. Pressing the button approves the price shown.'
  if (!connected) return 'You see the cost before anything is charged.'
  return ['Uses credits from your Comfy account.',
    model && !model.firmQuote && price ? `You see the exact cost after each ${model.kind === 'image' ? 'picture' : 'one'}.` : '',
    model?.refusalCharged === 'yes' ? 'This model charges even if it refuses a request.' : '',
    remembered === false ? 'Your key is kept until Velorn closes.' : ''].filter(Boolean).join(' ')
}

const NOUNS = { image: 'image', video: 'video', voice: 'voice recording', sound: 'sound effect', music: 'music' }
export const NOUN = kind => NOUNS[kind] || 'image'
const GO = { image: 'image', video: 'video', voice: 'voice', sound: 'effect', music: 'music' }

// Maps a failed call (or a failed job) to what the screen should do.
//   { screen: 'connect', keyError }            show the key step with a message
//   { screen: 'nocredits' }                    the not-enough-credits panel
//   { screen: 'compose', notice? }             stay on the box, optionally with a line of text
//   { screen: 'trouble', title, body, note, primary, secondary? }
export function problemFor(result, { model = null, kind = 'image' } = {}) {
  const code = result?.code || '', type = result?.diagnostics?.errorType || result?.job?.diagnostics?.errorType || '', http = result?.diagnostics?.httpStatus
  const jobError = result?.job?.errorType || result?.errorType || ''
  if (result?.queueNotEnabled || type === 'not_enabled') return { screen: 'connect',
    keyError: "This is an older kind of Comfy key that can't make images or videos here. Make a new key in your Comfy workspace and paste it in." }
  if (code === 'COMFY_ROUTER_AUTH' || type === 'unauthorized' || http === 401) return { screen: 'connect',
    keyError: "Comfy didn't accept that key. Check that you copied all of it, or make a new one and paste it here." }
  if (code === 'COMFY_ROUTER_KEY_REQUIRED') return { screen: 'connect', keyError: '' }
  if (type === 'insufficient_credits' || http === 402 || jobError === 'insufficient_credits') return { screen: 'nocredits' }
  if (code === 'COMFY_ROUTER_DECLINED') return { screen: 'compose' }
  if (code === 'COMFY_ROUTER_LOCAL_ONLY') return { screen: 'compose', notice: 'Cloud generation is turned off. Choose "Ask before cloud" in Settings, under Generation spending, to make this.' }
  if (code === 'COMFY_ROUTER_PROJECT_REQUIRED') return { screen: 'compose', notice: 'Open or save a project first, so the result has somewhere to go.' }
  if (code === 'COMFY_ROUTER_INVALID') return { screen: 'compose', notice: result?.error && !/Review the Comfy Router request/.test(result.error) ? result.error : "Comfy can't take that request as written. Check the description and try again." }
  if (code === 'ROUTER_EXPORT_BUSY') return { screen: 'compose', notice: 'Wait for the export to finish, then try again.' }
  if (code === 'COMFY_ROUTER_BUSY') return { screen: 'compose', notice: 'Another request is still being sent. Try again in a moment.' }
  if (type === 'content_policy_violation' || jobError === 'content_policy_violation') return { screen: 'trouble', kind: 'blocked',
    title: "Comfy wouldn't make this one",
    body: "The description or a picture you added goes against the model's content rules. Change the description and try again. What you wrote is still here.",
    note: model?.refusalCharged === 'yes' ? `${model.name} charges for a request even when it refuses it.`
      : model?.refusalCharged === 'no' ? "You weren't charged for this." : 'Your Comfy usage page shows whether this attempt was charged.',
    primary: 'Change the description' }
  if (code === 'COMFY_ROUTER_UNCERTAIN' || result?.job?.status === 'UNCERTAIN') return { screen: 'trouble', kind: 'lost',
    title: 'We lost touch with Comfy',
    body: `Your ${NOUN(kind)} may still be on its way. Check your Comfy usage page before generating again, or you could pay twice for the same thing.`,
    note: "Velorn won't send this request again on its own.", primary: 'Go back' }
  return { screen: 'trouble', kind: 'failed', title: "That one didn't work",
    body: 'Comfy ran into a problem and stopped. Your description and settings are still here.',
    note: 'Your Comfy usage page shows whether this attempt was charged.', primary: 'Try again', secondary: 'Change something first' }
}

// A finished job that did not succeed, as the same kind of answer.
export function problemForJob(job, context) {
  if (job?.status === 'CANCELLED') return { screen: 'compose', notice: 'Stopped. Your Comfy usage page shows whether it was charged.' }
  return problemFor({ job, errorType: job?.errorType, diagnostics: job?.diagnostics }, context)
}

// Comfy keeps a result for 24 hours. After that there is nothing left to collect.
export const RESULT_KEPT_MS = 24 * 60 * 60 * 1000
export const PICK_UP_MAX = 8

// Requests made in Create that Velorn stopped watching before their result was
// saved (it was closed, or the person moved on). `jobs` is the project's list
// from the main process. Oldest first. Nothing here is ever sent again: these
// are only watched and collected. Requests started from the paired phone are
// left out: they are saved into the project by their own watcher
// (phoneCreateSave.mjs), so the two never collect the same result.
export function unfinishedCreateJobs(jobs, now) {
  if (!Array.isArray(jobs)) return []
  return jobs.filter(job => job?.create === true && job.fromPhone !== true && job.canRefresh && !job.needsReconnect
    && (job.status === 'IN_QUEUE' || job.status === 'IN_PROGRESS' || (job.status === 'COMPLETED' && !job.importedAssetId))
    && Number.isFinite(job.createdAt) && now - job.createdAt < RESULT_KEPT_MS && now - job.createdAt >= 0)
    .sort((a, b) => a.createdAt - b.createdAt).slice(-PICK_UP_MAX)
}

export function goLabel({ step, kind, editing }) {
  if (step === 'sending') return 'Sending…'
  if (step === 'generating') return 'Generating…'
  return `${editing ? 'Edit' : 'Generate'} ${GO[kind] || 'image'}`
}
