// The agent's side of the built-in local voice (Kokoro). Pure checks only: what
// may be asked for, and how it is described back. The speaking itself is
// localVoice.js, the same service the Sound tab uses. It runs on this computer,
// needs no ComfyUI or key, and costs nothing.
import { LOCAL_VOICE } from './createFlow.mjs'

const MODEL = LOCAL_VOICE[0]
export const LOCAL_VOICE_TEXT_MAX = MODEL.characters.max
export const LOCAL_VOICE_DEFAULT = MODEL.voices[0].id
export const localVoiceList = () => MODEL.voices.map(voice => ({ id: voice.id, name: voice.name, note: voice.note }))

// Returns the checked request, or throws with wording an agent can act on.
export function planLocalVoice(payload = {}) {
  const allowed = ['text', 'voice', 'previewOnly']
  const extra = Object.keys(payload || {}).filter(key => !allowed.includes(key))
  if (extra.length) throw new Error(`generate_local_voice does not take "${extra[0]}". It takes text, voice and previewOnly.`)
  const text = typeof payload.text === 'string' ? payload.text.trim() : ''
  if (!text) throw new Error('Provide the words to say in text.')
  if (/\u0000/.test(text)) throw new Error('The text contains a character that cannot be spoken.')
  if (text.length > LOCAL_VOICE_TEXT_MAX) throw new Error(`The built-in voice takes up to ${LOCAL_VOICE_TEXT_MAX} characters at a time. This text has ${text.length}; split it into parts.`)
  const id = payload.voice === undefined ? LOCAL_VOICE_DEFAULT : payload.voice
  const voice = MODEL.voices.find(item => item.id === id)
  if (!voice) throw new Error(`Unknown voice. Choose one of: ${MODEL.voices.map(item => item.id).join(', ')}.`)
  return { text, voice: voice.id, voiceName: voice.name, voiceNote: voice.note, characters: text.length, model: MODEL.name }
}
